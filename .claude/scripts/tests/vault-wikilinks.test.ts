/**
 * Broken-wikilink RATCHET GATE (#108) — scans the REAL vault and asserts
 * the number of unresolvable wikilinks never EXCEEDS the recorded baseline
 * (`wikilink-baseline.json`).
 *
 * Why a ratchet and not a zero gate: user vaults legitimately carry gray
 * links (notes-to-be — a wikilink to a note you haven't written yet is an
 * Obsidian workflow, not a bug). The gate therefore fails only on
 * REGRESSION — a split, rename, or new note that breaks links that used
 * to resolve. The template repo itself ships at baseline 0; a vault
 * adopting this test with existing gray links records its own count in
 * the baseline file (the failure message says how) and ratchets DOWN
 * from there — lowering the baseline is always a one-line change, raising
 * it should hurt.
 *
 * Scan rules (mirror lib/wikilinks.ts semantics):
 *  - target set: every vault .md except machinery/config trees
 *  - source set: additionally excludes templates/ (placeholder links by
 *    design) and thinking/session-logs/ (transcripts)
 *  - resolution: basename OR frontmatter alias OR path suffix OR
 *    source-relative — see lib/wikilinks.ts header
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	extractWikilinkTargets,
	extractAliases,
	buildResolver,
} from "../lib/wikilinks.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASELINE_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"wikilink-baseline.json",
);

const TARGET_SKIP = [
	".git",
	".obsidian",
	".claude",
	".codex",
	".gemini",
	".github",
	".shardmind",
	"node_modules",
];
const SOURCE_SKIP_EXTRA = ["templates", "thinking/session-logs"];

function walkMd(root: string): string[] {
	const out: string[] = [];
	function walk(rel: string): void {
		let entries;
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const r = rel === "" ? e.name : `${rel}/${e.name}`;
			if (TARGET_SKIP.some((s) => r === s || r.startsWith(`${s}/`))) continue;
			if (e.isDirectory()) walk(r);
			else if (e.isFile() && /\.md$/i.test(e.name)) out.push(r);
		}
	}
	walk("");
	return out;
}

describe("vault wikilinks — ratchet gate", () => {
	test("broken wikilinks never exceed the recorded baseline", () => {
		const baseline = (
			JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as {
				allowedBroken: number;
			}
		).allowedBroken;

		const files = walkMd(repoRoot);
		assert.ok(
			files.length > 10,
			`sanity: expected a real vault, got ${files.length} files`,
		);

		const aliasesByFile = new Map<string, readonly string[]>();
		const contents = new Map<string, string>();
		for (const f of files) {
			const c = readFileSync(join(repoRoot, f), { encoding: "utf-8" });
			contents.set(f, c);
			const a = extractAliases(c);
			if (a.length > 0) aliasesByFile.set(f, a);
		}

		const resolves = buildResolver(files, aliasesByFile);
		const skippedSource = (f: string): boolean =>
			SOURCE_SKIP_EXTRA.some((s) => f === s || f.startsWith(`${s}/`));

		const broken: string[] = [];
		for (const f of files) {
			if (skippedSource(f)) continue;
			for (const t of extractWikilinkTargets(contents.get(f) ?? "")) {
				if (!resolves(t, f)) broken.push(`  ${f} → [[${t}]]`);
			}
		}

		assert.ok(
			broken.length <= baseline,
			`${broken.length} broken wikilink(s) exceed the baseline of ${baseline} — a change in this branch broke links that used to resolve. Fix the link, add an alias to the target, or create the note:\n${broken.join("\n")}\n(If these are intentional gray links in an adopting vault, raise allowedBroken in ${BASELINE_PATH} consciously.)`,
		);

		if (broken.length < baseline) {
			// Improvement — not a failure, but say so, so the ratchet tightens.
			console.log(
				`wikilink ratchet: ${broken.length} broken < baseline ${baseline} — lower allowedBroken in wikilink-baseline.json to lock the gain.`,
			);
		}
	});
});
