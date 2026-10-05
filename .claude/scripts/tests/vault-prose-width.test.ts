/**
 * Prose-width ZERO GATE (#247): no note in this vault has a hard-wrapped
 * paragraph.
 *
 * The write hook warns at write time, but a note edited in Obsidian never
 * passes through it, and one wrapped note is enough to teach the wrap to the
 * next session that reads it. So the vault itself is checked, the way
 * `vault-wikilinks.test.ts` checks links.
 *
 * Scope mirrors that gate: machinery and agent config trees are skipped, and
 * so are session transcripts. Templates are checked: every note made from one
 * inherits its shape. A note opts out with `verbatim: true`; a folder of raw
 * captures opts out with a `.verbatim` file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hardWrappedParagraphs } from "../lib/prose-width.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP = new Set([".git", ".obsidian", ".claude", ".codex", ".gemini", ".github", ".shardmind", "node_modules"]);
const SKIP_PATHS = new Set(["thinking/session-logs"]);

function notes(): string[] {
	const out: string[] = [];
	const walk = (rel: string): void => {
		if (SKIP_PATHS.has(rel) || (rel !== "" && existsSync(join(repoRoot, rel, ".verbatim")))) return;
		let entries;
		try {
			entries = readdirSync(join(repoRoot, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (SKIP.has(e.name)) continue;
			const r = rel === "" ? e.name : `${rel}/${e.name}`;
			if (e.isDirectory()) walk(r);
			else if (e.name.toLowerCase().endsWith(".md")) out.push(r);
		}
	};
	walk("");
	return out;
}

test("no note in this vault has a hard-wrapped paragraph", () => {
	const found = notes();
	assert.ok(found.length > 0, "the walk found no notes — a gate on an empty walk proves nothing");
	const offenders = found
		.map((rel) => ({ rel, lines: hardWrappedParagraphs(readFileSync(join(repoRoot, rel), "utf8")) }))
		.filter((o) => o.lines.length > 0);
	assert.deepEqual(
		offenders.map((o) => `${o.rel}: lines ${o.lines.join(", ")}`),
		[],
		"Write each paragraph as one line (GitHub renders a single newline as a break, and a wrapped note teaches the wrap to every session that reads it). " +
			"A raw capture whose breaks are the evidence opts out with `verbatim: true` in frontmatter. " +
			"A line split inside a code span (a `\\r` turned into a real newline by a script) shows up here too.",
	);
});
