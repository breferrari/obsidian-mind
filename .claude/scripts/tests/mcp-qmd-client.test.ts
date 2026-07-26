/**
 * The search filter.
 *
 * qmd indexes the whole vault, so `scopeResults` is the only thing that keeps
 * `search` agreeing with the other read surfaces about which notes exist.
 *
 * The tests are adversarial by design: most hand `scopeResults` a result set
 * containing a hit outside the served set and assert on its ABSENCE. An
 * assertion that the right hit came back passes just as well when the filter
 * does nothing at all, which is why the absence cases carry the weight.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
	pathKey,
	vaultRelKey,
	qmdRelKey,
	scopeResults,
	subQueries,
	createQmdClient,
	type QmdHit,
} from "../lib/mcp-qmd-client.ts";

const VAULT = "C:/Dev/myvault";

/** The set a caller scoped to `brain/` and `projects/` would get. */
const ALLOWED = new Set(["brain/gotchas.md", "brain/key-decisions.md", "projects/pocket/readme.md"]);

function hit(file: string, extra: Partial<QmdHit> = {}): QmdHit {
	return { file, score: 0.9, title: "t", snippet: "s", ...extra };
}

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

describe("path identity", () => {
	test("separator style and case do not change identity", () => {
		assert.equal(pathKey("Brain\\Gotchas.md"), "brain/gotchas.md");
	});

	test("spaces collapse to hyphens, because that is what the index does", () => {
		// `brain/Key Decisions.md` and `brain/Key-Decisions.md` are one document.
		// If these compared unequal, every note with a space in its name would be
		// permanently invisible to search while remaining readable as a resource.
		assert.equal(pathKey("brain/Key Decisions.md"), "brain/key-decisions.md");
	});

	test("a vault-relative key strips the root", () => {
		assert.equal(vaultRelKey(VAULT, "C:/Dev/myvault/brain/Gotchas.md"), "brain/gotchas.md");
		assert.equal(vaultRelKey(VAULT + "/", "C:\\Dev\\myvault\\brain\\Gotchas.md"), "brain/gotchas.md");
	});

	test("a path outside the vault keeps its full key rather than being mangled into one", () => {
		const k = vaultRelKey(VAULT, "C:/Dev/other/secret.md");
		assert.equal(k, "c:/dev/other/secret.md");
		assert.ok(!ALLOWED.has(k), "an outside path must never accidentally match an allowed key");
	});

	test("a qmd path drops its collection prefix", () => {
		assert.equal(qmdRelKey("myvault/brain/Gotchas.md"), "brain/gotchas.md");
	});

	test("a qmd path with no prefix is left alone", () => {
		assert.equal(qmdRelKey("gotchas.md"), "gotchas.md");
	});
});

// ---------------------------------------------------------------------------
// Sub-query shaping
// ---------------------------------------------------------------------------

describe("building sub-queries", () => {
	test("lexical and vector always go out together", () => {
		const types = subQueries("caching").map((s) => s.type);
		assert.ok(types.includes("lex"));
		assert.ok(types.includes("vec"));
	});

	test("a question-shaped query also gets hyde", () => {
		// hyde writes a hypothetical answer and matches against that, which is
		// what finds the note whose title shares no words with the question.
		for (const q of [
			"why did we choose postgres over mysql",
			"how does the retry envelope behave",
			"what happens when the lease expires?",
		]) {
			assert.ok(subQueries(q).some((s) => s.type === "hyde"), q);
		}
	});

	test("a keyword lookup does NOT pay for hyde", () => {
		// It runs a local generation model. Lexical matching is already the right
		// tool for a two-word lookup, so the cost buys nothing.
		for (const q of ["caching", "deploy runbook", "retry envelope", "postgres"]) {
			assert.ok(!subQueries(q).some((s) => s.type === "hyde"), q);
		}
	});

	test("a long non-question stays lex + vec", () => {
		const q = "connection pool timeout during the nightly batch reconciliation job";
		assert.deepEqual(subQueries(q).map((s) => s.type), ["lex", "vec"]);
	});

	test("every sub-query carries the trimmed text", () => {
		for (const s of subQueries("  why did we do this  ")) assert.equal(s.query, "why did we do this");
	});
});

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

describe("scoping results", () => {
	test("an in-scope hit comes back", () => {
		const r = scopeResults([hit("myvault/brain/Gotchas.md")], ALLOWED);
		assert.match(r.text, /brain\/Gotchas\.md/);
		assert.equal(r.withheld, 0);
	});

	test("an out-of-scope hit does NOT come back, and is counted", () => {
		// A note the index matched, sitting in a folder this vault does not serve.
		// The index knows nothing of the policy, so this filter is the only thing
		// between the two.
		const r = scopeResults([hit("myvault/work/1-1/2026-07-26 Sarah.md")], ALLOWED);
		assert.ok(!r.text.includes("Sarah"), "the withheld note must not appear at all");
		assert.ok(!r.text.includes("work/1-1"), "and neither must its path");
		assert.equal(r.withheld, 1);
	});

	test("a mixed result set returns only the permitted half and reports the rest", () => {
		const r = scopeResults(
			[
				hit("myvault/brain/Gotchas.md"),
				hit("myvault/people/Someone.md"),
				hit("myvault/projects/pocket/README.md"),
				hit("myvault/journal/2026-07-26.md"),
			],
			ALLOWED,
		);
		assert.match(r.text, /Gotchas/);
		assert.match(r.text, /pocket/);
		assert.ok(!r.text.includes("people/"), "people/ is not served");
		assert.ok(!r.text.includes("journal/"), "journal/ is not served");
		assert.equal(r.withheld, 2);
		assert.equal(r.total, 4);
		assert.match(r.text, /2 further match/);
	});

	test("everything withheld says so, rather than pretending the vault is empty", () => {
		// "(no results)" here would be a lie that sends the user looking for a
		// missing note instead of a scoping decision.
		const r = scopeResults([hit("myvault/people/A.md"), hit("myvault/people/B.md")], ALLOWED);
		assert.match(r.text, /withheld as out of scope/);
		assert.ok(!/^\(no results\)$/.test(r.text));
		assert.equal(r.withheld, 2);
	});

	test("a genuinely empty index is distinguishable from a fully withheld one", () => {
		const r = scopeResults([], ALLOWED);
		assert.equal(r.text, "(no results)");
		assert.equal(r.withheld, 0);
	});

	test("missing structured results REFUSE rather than fall back to the text summary", () => {
		// qmd also returns a human-readable summary that carries note paths. Using
		// it when the structured field is absent is precisely the unfiltered path.
		for (const bad of [undefined, null, "some summary text", { results: [] }, 42]) {
			const r = scopeResults(bad, ALLOWED);
			assert.match(r.text, /could not be scope-checked/, `refused for ${JSON.stringify(bad)}`);
		}
	});

	test("an empty allow-set withholds everything — a caller with no scope sees nothing", () => {
		const r = scopeResults([hit("myvault/brain/Gotchas.md")], new Set());
		assert.equal(r.withheld, 1);
		assert.ok(!r.text.includes("Gotchas"));
	});

	test("a hit with no file cannot slip through", () => {
		const r = scopeResults([{ score: 1, snippet: "unmatchable" } as QmdHit], ALLOWED);
		assert.equal(r.withheld, 1);
		assert.ok(!r.text.includes("unmatchable"));
	});

	test("basename collision does not admit a note from an out-of-scope folder", () => {
		// `projects/pocket/README.md` is allowed. A README elsewhere is not, and
		// matching on basename rather than full path would have admitted it.
		const r = scopeResults([hit("myvault/reference/runbooks/README.md")], ALLOWED);
		assert.equal(r.withheld, 1);
		assert.ok(!r.text.includes("runbooks"));
	});

	test("a note whose name contains spaces is matched, not silently dropped", () => {
		const allowed = new Set(["brain/key-decisions.md"]);
		const r = scopeResults([hit("myvault/brain/Key Decisions.md")], allowed);
		assert.equal(r.withheld, 0);
		assert.match(r.text, /Key Decisions/);
	});
});

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

describe("client liveness", () => {
	test("a client whose child exits reports itself dead", async () => {
		// The caller memoises this client. Without a liveness signal, one qmd
		// crash leaves a dead client in place whose pending map rejects every
		// later call — search stays broken for the life of the server.
		const c = createQmdClient(process.cwd(), join(process.cwd(), "definitely-not-a-launcher.mjs"));
		assert.equal(c.alive, true, "alive until proven otherwise");
		// Spawning a missing script fails asynchronously; wait for the signal.
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(c.alive, false, "a failed launcher must mark the client dead");
		c.dispose();
	});

	test("dispose marks it dead too", () => {
		const c = createQmdClient(process.cwd(), join(process.cwd(), "also-missing.mjs"));
		c.dispose();
		assert.equal(c.alive, false);
	});

	test("a call against a dead client rejects rather than hanging", async () => {
		const c = createQmdClient(process.cwd(), join(process.cwd(), "still-missing.mjs"));
		await new Promise((r) => setTimeout(r, 400));
		await assert.rejects(() => c.call("tools/call", {}), /qmd/i);
		c.dispose();
	});
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("rendering", () => {
	test("limit caps the hits shown but the withheld count still reflects the policy", () => {
		const hits = [hit("myvault/brain/Gotchas.md"), hit("myvault/brain/Key Decisions.md")];
		const r = scopeResults([...hits, hit("myvault/people/X.md")], ALLOWED, 1);
		assert.equal(r.withheld, 1, "withheld counts the POLICY, not the limit");
		assert.equal((r.text.match(/^\[\d\]/gm) ?? []).length, 1);
	});

	test("a limit of zero returns no hits without throwing", () => {
		const r = scopeResults([hit("myvault/brain/Gotchas.md")], ALLOWED, 0);
		assert.match(r.text, /no results/);
	});

	test("a negative limit is treated as zero rather than slicing from the end", () => {
		// `slice(-1)` would return the LAST hit — quietly returning something the
		// caller did not ask for.
		const r = scopeResults([hit("myvault/brain/Gotchas.md")], ALLOWED, -1);
		assert.match(r.text, /no results/);
	});

	test("a long snippet is truncated and whitespace normalised", () => {
		const r = scopeResults([hit("myvault/brain/Gotchas.md", { snippet: "x\n\n  y".repeat(500) })], ALLOWED);
		assert.ok(r.text.length < 2000);
		assert.ok(!r.text.includes("\n\n  y"), "internal whitespace is collapsed");
	});

	test("the whole response is bounded even with many large hits", () => {
		const many = Array.from({ length: 50 }, () => hit("myvault/brain/Gotchas.md", { snippet: "z".repeat(700) }));
		const r = scopeResults(many, ALLOWED, 50);
		assert.ok(r.text.length <= 6200, `response was ${r.text.length} bytes`);
	});

	test("score renders as a percentage and a missing score does not print NaN", () => {
		const r = scopeResults([hit("myvault/brain/Gotchas.md", { score: 0.93 })], ALLOWED);
		assert.match(r.text, /score 93%/);
		const noScore = scopeResults([{ file: "myvault/brain/Gotchas.md" }], ALLOWED);
		assert.match(noScore.text, /score 0%/);
		assert.ok(!noScore.text.includes("NaN"));
	});

	test("a line number is included when present and omitted when not", () => {
		assert.match(scopeResults([hit("myvault/brain/Gotchas.md", { line: 42 })], ALLOWED).text, /Gotchas\.md:42/);
		assert.ok(!scopeResults([hit("myvault/brain/Gotchas.md")], ALLOWED).text.includes(".md:"));
	});
});
