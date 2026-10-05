/**
 * The vault-wide check that every anchored `promoted:` marker resolves (#246).
 *
 * `resolvePromoted` is careful and well tested on fixtures, but nothing
 * asserted that a REAL vault's markers resolve, and one routine edit breaks
 * them silently: splitting a note. A split retargets the wikilinks in view,
 * while the markers pointing into the note live in `memories/` and are not
 * in view, so every one of them is orphaned and recall quietly falls back to
 * the capture as first written. The hygiene report already said so, every
 * session, and nothing acted on it, because a report can be walked past and
 * a failing test cannot.
 *
 * Resolution is `auditPromotions`, the same path `health` reports from, so
 * the gate and the report cannot disagree about what "resolves" means. On
 * top of it the gate requires a block anchor to be DEFINED exactly once in
 * its note. A definition is `^anchor` not preceded by `#` (a `[[#^anchor]]`
 * or `[[Note#^anchor]]` is a reference to it, and counting those penalised
 * exactly the cross-linking a vault wants) and not followed by another
 * identifier character (`^om-fix` is a prefix of `^om-fix-escape`).
 *
 * Unanchored markers are skipped: a bare `promoted: brain/Note` is a
 * deliberate, reported state, not a defect.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExposurePolicy } from "./mcp-exposure.ts";
import { resolveExposedNote } from "./mcp-exposure.ts";
import { auditPromotions } from "./memory-promoted.ts";
import { readMemories } from "./memory-recall.ts";
import { stripFrontmatter } from "./session-start.ts";

export type PromotedGateResult = {
	/** Markdown files under the memory root, parsed or not. */
	readonly files: number;
	/** Captures the store reader parsed. */
	readonly captures: number;
	/** Markers carrying an anchor — the only kind the gate checks. */
	readonly anchored: number;
	/** One line per marker that does not resolve, naming the capture. */
	readonly failures: readonly string[];
};

function countMarkdown(dir: string): number {
	let n = 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const name of entries) {
		const full = join(dir, name);
		try {
			if (statSync(full).isDirectory()) n += countMarkdown(full);
			else if (name.toLowerCase().endsWith(".md")) n++;
		} catch {
			/* vanished mid-walk */
		}
	}
	return n;
}

/** How many times `^anchor` is defined in `body`: not after `#`, ended on a boundary. */
export function countAnchorDefinitions(body: string, anchor: string): number {
	const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return (body.match(new RegExp(`(?<!#)\\^${escaped}(?![\\w-])`, "g")) ?? []).length;
}

export function checkPromotedMarkers(vaultRoot: string, memoryRoot: string): PromotedGateResult {
	const files = countMarkdown(join(vaultRoot, memoryRoot));
	const entries = readMemories(vaultRoot, memoryRoot);
	const failures: string[] = [];

	// The gate asks whether a marker RESOLVES, not whether the server may serve
	// it, so every marker's own folder is treated as exposed here.
	const roots = new Set<string>();
	for (const e of entries) {
		const note = e.facets.promoted?.note;
		const top = note?.split("/")[0];
		if (top && top !== note) roots.add(top);
	}
	const policy: ExposurePolicy = { roots: [...roots], neverExpose: new Set(), source: "manifest", memoryRoot };

	const audit = auditPromotions(
		vaultRoot,
		policy,
		entries.map((e) => ({ path: e.rel, facets: e.facets })),
	);
	for (const p of audit.unparsed) failures.push(`${p}: promoted: marker cannot be parsed`);
	for (const b of audit.broken) {
		const why = b.status === "stale-anchor" ? "its anchor is not in that note (moved by a split?)" : `the note is ${b.status}`;
		failures.push(`${b.path}: promoted into ${b.note}, but ${why}`);
	}

	// A block anchor that resolved may still be defined twice; recall serves
	// the first, which may not be the block that was promoted.
	for (const e of entries) {
		const ref = e.facets.promoted;
		if (!ref || ref.anchor === null || ref.kind !== "block") continue;
		const full = resolveExposedNote(vaultRoot, policy, ref.note);
		if (full === null || !existsSync(full)) continue; // already reported as broken
		let body = "";
		try {
			body = stripFrontmatter(readFileSync(full, "utf8"));
		} catch {
			continue;
		}
		const defs = countAnchorDefinitions(body, ref.anchor);
		if (defs > 1) failures.push(`${e.rel}: ^${ref.anchor} is defined ${defs} times in ${ref.note}; recall cannot tell which block is meant`);
	}

	// `broken` holds anchored markers only; a bare marker counts as named-only.
	return { files, captures: entries.length, anchored: audit.served + audit.broken.length, failures };
}
