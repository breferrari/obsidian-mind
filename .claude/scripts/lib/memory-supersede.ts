/**
 * Supersession — knowledge that corrects itself.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 *
 * A flat memory store accumulates contradictions. It learns "X is true", later
 * learns "X is false", and then holds both with equal authority forever. Every
 * subsequent retrieval is a coin flip, and the store gets *less* trustworthy the
 * longer it runs — the opposite of what memory is for.
 *
 * Supersession makes a correction first-class: the new memory declares what it
 * replaces, the old one records that it was replaced, and retrieval ranks the
 * correction above the thing it corrected. Nothing is deleted, because the
 * history is occasionally the point ("we used to think X, here is why we
 * stopped") and because removing a note the user may have linked is not the
 * server's call.
 *
 * THIS MODULE IS THE ONLY PLACE THE SERVER EDITS AN EXISTING FILE.
 *
 * Isolated deliberately so that stays auditable. Two rules, enforced here rather
 * than documented and hoped for:
 *
 *   1. It may only touch a note it wrote (`source: mcp-capture`). A human's note
 *      is never modified, whatever it happens to be linked to.
 *   2. It only ADDS a frontmatter key. Never rewrites a body, removes a key, or
 *      reorders. The blast radius of a bug here is one extra line.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORY_SOURCE } from "./memory-write.ts";

/** The only `source` value this module is permitted to modify. */
const OWNED_BY_SERVER = MEMORY_SOURCE;

export interface FrontmatterEdit {
	readonly changed: boolean;
	readonly text: string;
	readonly reason: string;
}

export interface SupersedeResult {
	readonly ok: boolean;
	readonly changed?: boolean;
	readonly reason: string;
}

/** Anything with a title, which is all supersession matching needs. */
export interface Titled {
	readonly title?: string | null;
	readonly rel?: string;
}

/**
 * Add or extend a list-valued frontmatter key. Pure.
 *
 * Returns the text unchanged when the value is already present, so a repeated
 * supersession is a no-op rather than a growing list of duplicates.
 */
export function addToFrontmatterList(md: string, key: string, value: string): FrontmatterEdit {
	const m = String(md).match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
	if (!m) return { changed: false, text: md, reason: "no frontmatter block" };

	const open = m[1]!;
	const block = m[2]!;
	const close = m[3]!;
	const lineRe = new RegExp(`^${key}:\\s*(.*)$`, "m");
	const existing = block.match(lineRe);
	const quoted = JSON.stringify(String(value));

	let nextBlock: string;
	if (existing) {
		const raw = (existing[1] ?? "").trim();
		if (raw.includes(quoted)) return { changed: false, text: md, reason: "already present" };
		const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1).trim() : "";
		nextBlock = block.replace(lineRe, `${key}: ${inner ? `[${inner}, ${quoted}]` : `[${quoted}]`}`);
	} else {
		nextBlock = `${block}\n${key}: [${quoted}]`;
	}

	return {
		changed: true,
		text: md.replace(open + block + close, open + nextBlock + close),
		reason: existing ? "extended" : "added",
	};
}

/** Read a single frontmatter scalar without pulling in the whole parser. */
function frontmatterScalar(md: string, key: string): string | null {
	const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const line = (m[1] ?? "").match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	if (!line) return null;
	const raw = (line[1] ?? "").trim();
	try {
		return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
	} catch {
		return raw;
	}
}

/**
 * Mark an existing memory as superseded by a newer one.
 *
 * Refuses — loudly, without writing — on anything it does not own. A refusal is
 * returned rather than thrown so a capture is never lost because its
 * housekeeping half failed: the memory still lands, and the caller is told the
 * back-link could not be written.
 */
export function markSuperseded(vaultRoot: string, rel: string, supersedingTitle: string): SupersedeResult {
	const full = join(vaultRoot, rel);
	let md: string;
	try {
		md = readFileSync(full, "utf8");
	} catch {
		return { ok: false, reason: `cannot read ${rel}` };
	}

	if (frontmatterScalar(md, "source") !== OWNED_BY_SERVER) {
		return {
			ok: false,
			reason: `refusing to modify ${rel}: not an agent-written memory (source is not ${OWNED_BY_SERVER})`,
		};
	}

	const result = addToFrontmatterList(md, "superseded_by", supersedingTitle);
	if (!result.changed) return { ok: true, changed: false, reason: result.reason };

	writeFileSync(full, result.text, "utf8");
	return { ok: true, changed: true, reason: result.reason };
}

/**
 * Resolve the memories a capture claims to supersede.
 *
 * Matching is on title, because that is what a calling session actually has —
 * it saw the title in a recall result. Exact (case-insensitive) only: a fuzzy
 * match here would let a session retire the wrong memory, which is the one
 * irreversible-feeling action in this whole layer.
 */
export function resolveSupersedes<T extends Titled>(
	claims: unknown,
	existing: readonly T[],
): { matched: T[]; unmatched: string[] } {
	const matched: T[] = [];
	const unmatched: string[] = [];
	for (const claim of Array.isArray(claims) ? claims : []) {
		const needle = String(claim ?? "").trim().toLowerCase();
		if (!needle) continue;
		const hit = existing.find((e) => String(e.title ?? "").trim().toLowerCase() === needle);
		if (hit) matched.push(hit);
		else unmatched.push(String(claim));
	}
	return { matched, unmatched };
}
