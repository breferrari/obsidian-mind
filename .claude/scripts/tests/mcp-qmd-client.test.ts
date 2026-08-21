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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	pathKey,
	vaultRelKey,
	qmdRelKey,
	scopeResults,
	subQueries,
	createQmdClient,
	callBudget,
	timeoutMessage,
	qmdProbe,
	probeBudget,
	type QmdHit,
	type QmdClient,
} from "../lib/mcp-qmd-client.ts";

/**
 * Write a stand-in qmd launcher that speaks just enough MCP to exercise the
 * client, and return its path.
 *
 * A fake rather than the real qmd because the behaviours under test are all
 * about TIMING and SHAPE — a call that never answers, a reply with no
 * structured results — and none of them can be provoked on demand from a
 * working qmd. The one that matters most, a first call that outlives its
 * budget, is reproducible here in 300ms and was reproducible in production
 * only on a machine that had never run qmd before.
 *
 * Modes: `ok` answers with structured results, `nostruct` answers without
 * them, `silent` completes the handshake and then never answers a tools/call.
 * Every mode answers `initialize`, because the handshake was never the thing
 * that broke.
 */
function fakeLauncher(dir: string, mode: "ok" | "nostruct" | "silent"): string {
	const file = join(dir, "fake-qmd.mjs");
	writeFileSync(
		file,
		`import { createInterface } from "node:readline";
const MODE = ${JSON.stringify(mode)};
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (typeof msg.id !== "number") return;
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {} } });
		return;
	}
	if (msg.method !== "tools/call") return;
	if (MODE === "silent") return;
	if (MODE === "nostruct") {
		send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "no structure here" }] } });
		return;
	}
	send({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: { results: [{ file: "v/brain/Gotchas.md", score: 0.9, title: "t", snippet: "s" }] } } });
});
`,
		"utf-8",
	);
	return file;
}

/**
 * Run `fn` against a fake-backed client and ALWAYS reap the child.
 *
 * The cleanup lives in `finally` rather than after the assertions because a
 * failing assertion would otherwise skip `dispose`, and the orphaned child
 * holds its stdin open — which stops the test runner draining its event loop.
 * The first draft of these tests did exactly that: one broken assertion turned
 * a clean failure into a hang, i.e. into the slowest possible way to learn the
 * same thing.
 */
async function withFake<T>(
	mode: "ok" | "nostruct" | "silent",
	fn: (c: QmdClient) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "qmd-fake-"));
	const c = createQmdClient(process.cwd(), fakeLauncher(dir, mode));
	try {
		return await fn(c);
	} finally {
		c.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

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

// ---------------------------------------------------------------------------
// Cold start
//
// On 2026-08-22 a foreign repo's first search of a session failed with
// `qmd timeout on tools/call`, `health` reported no warnings, and the identical
// query succeeded minutes later. The cause was not the query and not a
// readiness race — `qmdSearch` already awaits `ready`, and the handshake
// measured 161ms. qmd was downloading its 639MB reranker model inside the first
// query; the flat 45s budget expired at 45.02s.
//
// What makes that expensive is not the wait. The documented response to a
// failed search is to call `health` and, if it is clean, conclude the record is
// not there — so these tests are as much about what the caller is TOLD as about
// what is waited for.
// ---------------------------------------------------------------------------

describe("call budgets", () => {
	test("the first tools/call is given room for a model download", () => {
		// 45s was not a wrong number so much as a wrong SHAPE: the cost it bounds
		// is a network fetch of a few hundred MB, whose duration belongs to the
		// connection. Anything that could plausibly be beaten by a slow link would
		// reintroduce the same failure on a worse day.
		assert.ok(
			callBudget("tools/call", false) >= 5 * 60_000,
			"a cold search must tolerate a slow download, not race it",
		);
	});

	test("a warmed client goes back to the short budget", () => {
		// The generous budget is a one-time concession. Keeping it would mean a
		// genuinely wedged qmd hangs a caller for ten minutes with no signal.
		assert.ok(callBudget("tools/call", true) < callBudget("tools/call", false));
		assert.equal(callBudget("tools/call", true), 45_000);
	});

	test("the handshake is never given the cold budget", () => {
		// `initialize` is a pure handshake — measured at ~160ms — and pays none of
		// the model cost. Extending its budget would only delay the report of a
		// launcher that is answering but broken.
		assert.equal(callBudget("initialize", false), callBudget("tools/call", true));
	});
});

describe("what a timeout tells the caller", () => {
	test("a cold search timeout names the cause and blocks the wrong conclusion", () => {
		const m = timeoutMessage("tools/call", 600_000, false);
		assert.match(m, /download/i, "the cause has to be named or it reads as a broken vault");
		assert.match(m, /first search/i);
		// The load-bearing assertion. A caller who follows the documented failure
		// path lands on "nothing is recorded"; on 2026-08-22 the record existed and
		// was complete, and re-deriving it would have cost a night's work.
		assert.match(m, /do not conclude it is missing/i);
		assert.match(m, /retry/i);
	});

	test("a warmed timeout stays terse and claims nothing about downloads", () => {
		// Blaming a download for every timeout would make the cold message noise,
		// and noise is how a real signal stops being read.
		const m = timeoutMessage("tools/call", 45_000, true);
		assert.doesNotMatch(m, /download/i);
		assert.match(m, /45s/);
	});

	test("the handshake timeout is terse too", () => {
		assert.doesNotMatch(timeoutMessage("initialize", 45_000, false), /download/i);
	});
});

describe("client warmth", () => {
	test("a fresh client is not warm", () => {
		const c = createQmdClient(process.cwd(), join(process.cwd(), "no-launcher.mjs"));
		try {
			assert.equal(c.warmed, false, "nothing has come back yet, so nothing is proven");
		} finally {
			c.dispose();
		}
	});

	test("the handshake does not count as warmth", async () => {
		// A handshake proves the process speaks MCP. It measured ~160ms in
		// production while the thing that actually blocked search — a 639MB model
		// download — had not started. Treating it as warmth is how 45s came to look
		// like enough.
		await withFake("ok", async (c) => {
			await c.ready;
			assert.equal(c.warmed, false);
		});
	});

	test("a tools/call still IN FLIGHT does not confer warmth", async () => {
		// The assertion the whole flag exists for. Warmth means "the models are
		// loaded", and only a reply proves that. Setting it when the request is
		// SENT would hand the short 45s budget to a second search queued behind the
		// very download the first one is still waiting on — reproducing the
		// original failure on the caller least able to explain it.
		await withFake("silent", async (c) => {
			await c.ready;
			const inflight = c.call("tools/call", { name: "query", arguments: {} }, 400);
			await new Promise((r) => setTimeout(r, 150));
			assert.equal(c.warmed, false, "sent is not answered");
			await assert.rejects(() => inflight);
			assert.equal(c.warmed, false, "a timed-out call proves nothing either");
		});
	});

	test("a tools/call that returns confers warmth", async () => {
		await withFake("ok", async (c) => {
			await c.call("tools/call", { name: "query", arguments: {} });
			assert.equal(c.warmed, true);
		});
	});
});

describe("the health probe", () => {
	test("a cold probe waits for the model load; a warm one does not", () => {
		// Measured: ~31ms warm, 2.9s with the models hot in the page cache, 10.5s
		// with them cold. A single budget sized for the warm case would report a
		// healthy vault as DEGRADED — from the one tool a caller reaches for when
		// they already suspect a problem, which is the worst place to be wrong.
		assert.ok(probeBudget(false) >= 30_000, "a cold probe must outlast a ~10s model load");
		assert.ok(probeBudget(true) <= 10_000, "a warm probe must keep health snappy");
		assert.ok(probeBudget(false) > probeBudget(true));
		// A real search waits out a download; a diagnostic gives up and REPORTS.
		assert.ok(probeBudget(false) < callBudget("tools/call", false));
	});

	test("a qmd that answers is reported ok, with a latency", async () => {
		await withFake("ok", async (c) => {
			const r = await qmdProbe(c, 5_000);
			assert.equal(r.ok, true);
			assert.match(r.detail, /answered in \d+ms/);
		});
	});

	test("answering without structured results is NOT healthy", async () => {
		// `scopeResults` cannot scope-check hits it cannot see, so every search
		// would return "(search unavailable)" while the transport looked perfect.
		// A probe that only checked for a reply would call this fine — and a probe
		// that reports fine during an outage is the defect this whole change is
		// about, just relocated.
		await withFake("nostruct", async (c) => {
			const r = await qmdProbe(c, 5_000);
			assert.equal(r.ok, false);
			assert.match(r.detail, /structured/i);
		});
	});

	test("a qmd that never answers is reported degraded", async () => {
		await withFake("silent", async (c) => {
			const r = await qmdProbe(c, 300);
			assert.equal(r.ok, false);
			assert.match(r.detail, /DEGRADED/);
			assert.match(r.detail, /download/i, "the likeliest cause has to travel with the report");
			// The probe's budget is short so `health` stays fast; search's is minutes.
			// Echoing the raw timeout would publish the probe's number as if it were
			// search's, and the next person to tune a timeout would tune the wrong one.
			assert.doesNotMatch(r.detail, /qmd timeout/);
		});
	});

	test("a launcher that will not start is reported as not answering", async () => {
		const c = createQmdClient(process.cwd(), join(process.cwd(), "absent-launcher.mjs"));
		try {
			const r = await qmdProbe(c, 2_000);
			assert.equal(r.ok, false);
			assert.match(r.detail, /DID NOT ANSWER/);
		} finally {
			c.dispose();
		}
	});
});
