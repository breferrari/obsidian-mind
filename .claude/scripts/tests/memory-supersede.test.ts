/**
 * Supersession — the only path where the server edits an existing file.
 *
 * The tests that matter most here are the refusals. A layer that can rewrite
 * notes is only safe if it provably declines to touch anything it did not
 * write, so that case asserts the file is byte-identical afterwards rather than
 * merely that a flag came back false.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { addToFrontmatterList, markSuperseded, resolveSupersedes } from "../lib/memory-supersede.ts";
import { validateMemory, writeMemory } from "../lib/memory-write.ts";
import { recall, parseFrontmatter, facetsOf } from "../lib/memory-recall.ts";

const MD = "---\ndate: 2026-07-26\nsource: mcp-capture\nscope: general\n---\n\n# t\n\nbody\n";

function vaultWith(md: string): { dir: string; rel: string } {
	const dir = mkdtempSync(join(tmpdir(), "sup-"));
	const rel = "memories/2026/07/2026-07-26 old.md";
	mkdirSync(dirname(join(dir, rel)), { recursive: true });
	writeFileSync(join(dir, rel), md, "utf8");
	return { dir, rel };
}

describe("frontmatter surgery", () => {
	test("adds a new list key without touching anything else", () => {
		const r = addToFrontmatterList(MD, "superseded_by", "New Title");
		assert.equal(r.changed, true);
		assert.ok(r.text.includes('superseded_by: ["New Title"]'));
		assert.ok(r.text.includes("date: 2026-07-26"), "existing keys must survive");
		assert.ok(r.text.endsWith("body\n"), "the body must be untouched");
	});

	test("extends an existing list rather than replacing it", () => {
		const once = addToFrontmatterList(MD, "superseded_by", "First").text;
		assert.ok(addToFrontmatterList(once, "superseded_by", "Second").text.includes('["First", "Second"]'));
	});

	test("re-adding the same value is a no-op", () => {
		const once = addToFrontmatterList(MD, "superseded_by", "First").text;
		const again = addToFrontmatterList(once, "superseded_by", "First");
		assert.equal(again.changed, false);
		assert.equal(again.text, once);
	});

	test("a file with no frontmatter is left alone", () => {
		assert.equal(addToFrontmatterList("# just a body\n", "superseded_by", "x").changed, false);
	});

	test("values containing quotes cannot break the YAML", () => {
		const r = addToFrontmatterList(MD, "superseded_by", 'a "quoted" title');
		const inner = r.text.match(/superseded_by: \[(.*)\]/)?.[1];
		assert.ok(inner);
		assert.doesNotThrow(() => JSON.parse(inner));
	});
});

describe("markSuperseded", () => {
	test("marks an agent-written memory and reports the change", () => {
		const { dir, rel } = vaultWith(MD);
		try {
			const r = markSuperseded(dir, rel, "The Correction");
			assert.equal(r.ok, true);
			assert.equal(r.changed, true);
			assert.ok(readFileSync(join(dir, rel), "utf8").includes('superseded_by: ["The Correction"]'));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REFUSES to modify a note it did not write, byte-for-byte", () => {
		// The safety rule that matters most: a human's note is never edited,
		// whatever it happens to be linked to.
		const original = "---\ntitle: my own note\n---\n\n# mine\n\nhand written\n";
		const { dir, rel } = vaultWith(original);
		try {
			const r = markSuperseded(dir, rel, "The Correction");
			assert.equal(r.ok, false);
			assert.match(r.reason, /refusing to modify/);
			assert.equal(readFileSync(join(dir, rel), "utf8"), original);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a missing file returns a refusal rather than throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-"));
		try {
			assert.equal(markSuperseded(dir, "memories/nope.md", "x").ok, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveSupersedes", () => {
	const existing = [
		{ rel: "a.md", title: "The Old Lesson" },
		{ rel: "b.md", title: "Another Memory" },
	];

	test("matches on exact title, case-insensitively", () => {
		const r = resolveSupersedes(["the old lesson"], existing);
		assert.equal(r.matched.length, 1);
		assert.equal(r.matched[0]!.rel, "a.md");
	});

	test("does NOT fuzzy match — retiring the wrong memory is the one bad outcome", () => {
		const r = resolveSupersedes(["The Old"], existing);
		assert.equal(r.matched.length, 0);
		assert.deepEqual(r.unmatched, ["The Old"]);
	});

	test("unmatched claims are reported so the caller learns nothing was retired", () => {
		assert.deepEqual(resolveSupersedes(["Ghost"], existing).unmatched, ["Ghost"]);
	});

	test("empty and malformed claims are ignored safely", () => {
		assert.deepEqual(resolveSupersedes(null, existing).matched, []);
		assert.deepEqual(resolveSupersedes(["", "  "], existing).matched, []);
	});
});

// ---------------------------------------------------------------------------
// End to end: a correction lands and outranks what it corrected
// ---------------------------------------------------------------------------

/**
 * The unit tests above prove each half in isolation. This is the claim that
 * actually matters to a user, and it can only be made by driving the real
 * writer, the real supersession and the real reader in sequence: a flat store
 * that learns "X" and later "not X" holds both with equal authority forever and
 * gets LESS trustworthy the longer it runs. Here the correction wins and the
 * history survives.
 */
describe("correction round trip", () => {
	const DAY = new Date(2026, 6, 26);

	test("the correction outranks the corrected memory in recall", () => {
		const dir = mkdtempSync(join(tmpdir(), "corr-"));
		try {
			const caller = { project: "atlas", platforms: [] };

			const oldV = validateMemory(
				{
					title: "atlas tokens expire after one hour",
					body: "Observed the session token being rejected sixty minutes after issue during manual testing.",
					confidence: "inferred",
					projects: ["atlas"],
				},
				{ now: new Date(2026, 5, 1), origin: "atlas" },
			);
			const oldWritten = writeMemory(dir, oldV.value!, []);

			const newV = validateMemory(
				{
					title: "atlas tokens expire after fifteen minutes not one hour",
					body: "The hour figure was wrong: the gateway shortened the TTL. Confirmed against the issuer config on 2026-07-26.",
					confidence: "verified",
					verification: "Read the issuer config directly.",
					projects: ["atlas"],
				},
				{ now: DAY, origin: "atlas" },
			);
			writeMemory(dir, newV.value!, []);

			const marked = markSuperseded(dir, oldWritten.rel, newV.value!.title);
			assert.equal(marked.ok, true);

			const results = recall(dir, caller);
			assert.equal(results.length, 2, "nothing is deleted — the history survives");
			assert.ok(
				String(results[0]!.title).includes("fifteen minutes"),
				`the correction must rank first, got: ${results[0]!.title}`,
			);
			assert.ok(
				results[1]!.facets.superseded_by.length > 0,
				"the corrected memory carries its back-link",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a superseded memory is still readable and still carries its facets", () => {
		const dir = mkdtempSync(join(tmpdir(), "corr2-"));
		try {
			const v = validateMemory(
				{
					title: "a fact that later changed",
					body: "Recorded before the correction arrived, in good faith.",
					confidence: "inferred",
					projects: ["atlas"],
				},
				{ now: DAY, origin: "atlas" },
			);
			const w = writeMemory(dir, v.value!, []);
			markSuperseded(dir, w.rel, "the newer one");
			const fm = facetsOf(parseFrontmatter(readFileSync(join(dir, w.rel), "utf8")));
			assert.deepEqual(fm.projects, ["atlas"]);
			assert.deepEqual(fm.superseded_by, ["the newer one"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
