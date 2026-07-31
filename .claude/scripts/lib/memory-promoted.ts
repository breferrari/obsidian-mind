/**
 * Serving a promoted lesson through the capture that still declares its reach.
 *
 * `recall` reads only the memory root and `search`/`expand` see everything but,
 * so the two surfaces are disjoint. A lesson promoted into `brain/` therefore
 * exists twice, and a foreign repo can only reach the capture — the version as
 * first written, which may predate a correction swept through the promoted one.
 *
 * The design turns on one fact that only became true in v8.2.0: **promotion is
 * additive, so the capture never leaves.** That means the capture is still the
 * reach record and it is already correct, and nothing about `scope`, `projects`
 * or `platforms` has to migrate onto an ordinary note. Visibility is computed
 * exactly as before; only the CONTENT served changes.
 *
 * Three properties make that safe, and each is enforced here rather than
 * assumed by the caller:
 *
 *   1. **Opt-in by construction.** Content is served only when the marker
 *      carries an ANCHOR. A bare `promoted: brain/Note` keeps the old
 *      behaviour. Anchors are written by the promotion step, so pointing at a
 *      block is a deliberate act rather than an automatic consequence of the
 *      marker existing — and every capture promoted before this shipped keeps
 *      today's behaviour until someone re-points it.
 *   2. **The exposure policy still bounds every read.** This is the first time
 *      `recall` reads outside the memory root, so the root list is checked and
 *      traversal is refused, exactly as the write path does.
 *   3. **It degrades rather than guesses.** A stale anchor returns the reason,
 *      never the whole note. Returning a `Gotchas` note because one bullet in
 *      it was promoted is worse than returning nothing, and it is the failure
 *      mode that made "what is the unit?" the hard question.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { ExposurePolicy } from "./mcp-exposure.ts";

/** A parsed `promoted:` marker. */
export interface PromotedRef {
	/** Vault-relative note path, always ending in `.md`. */
	readonly note: string;
	/** Block id (without `^`), heading text, or null for a bare note reference. */
	readonly anchor: string | null;
	readonly kind: "block" | "heading" | "note";
}

export type PromotedResolution =
	/** The promoted text, which is what the caller should read instead. */
	| { readonly status: "served"; readonly note: string; readonly anchor: string; readonly text: string }
	/** A bare marker: named, never served. The pre-existing behaviour. */
	| { readonly status: "no-anchor"; readonly note: string }
	/** The target is outside the exposed roots. Named, never served. */
	| { readonly status: "not-exposed"; readonly note: string }
	/** The anchor no longer resolves — the block was renamed, moved or removed. */
	| { readonly status: "stale-anchor"; readonly note: string; readonly anchor: string }
	/** The note is gone or unreadable. */
	| { readonly status: "unreadable"; readonly note: string };

/**
 * Split a marker into a note and an optional anchor.
 *
 * `brain/Gotchas - Engineering#^om-a1b2c3` → block `om-a1b2c3`
 * `brain/Gotchas - Engineering#Some Heading` → heading `Some Heading`
 * `brain/Gotchas - Engineering` → bare note
 *
 * A `.md` suffix is optional in the marker and always present in the result, so
 * the two spellings cannot resolve to different files.
 */
export function parsePromotedMarker(raw: unknown): PromotedRef | null {
	// A non-string marker is malformed frontmatter, not a path. Coercing it
	// produces a plausible-looking reference (`42` → `42.md`) that then fails
	// the exposure check and reports as "outside the exposed roots" — a
	// misleading answer to a question nobody asked. `facetsOf` already narrows
	// to string, so this is the second gate rather than the only one.
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (!s) return null;

	const hash = s.indexOf("#");
	const notePart = (hash === -1 ? s : s.slice(0, hash)).trim();
	const anchorPart = hash === -1 ? "" : s.slice(hash + 1).trim();
	if (!notePart) return null;

	const note = notePart.toLowerCase().endsWith(".md") ? notePart : `${notePart}.md`;
	if (!anchorPart) return { note, anchor: null, kind: "note" };
	if (anchorPart.startsWith("^")) {
		const id = anchorPart.slice(1).trim();
		return id ? { note, anchor: id, kind: "block" } : { note, anchor: null, kind: "note" };
	}
	return { note, anchor: anchorPart, kind: "heading" };
}

/**
 * Is this note inside a root the policy serves?
 *
 * Same shape as the write path's check, and for the same reason: containment
 * against the vault is the wrong question, because roots are per-folder. A
 * marker is vault-authored rather than caller-supplied, so this is a guard
 * against a mistake rather than against an attack — but a guard that only holds
 * for trusted input is not a guard, and `promoted:` is a string in a file that
 * a foreign repo's capture can carry.
 *
 * **Three checks, and mutation testing says only one of them is load-bearing
 * against string input.** Recorded here because the finding is exactly what
 * makes a later refactor dangerous:
 *
 *   - the **root allowlist** is what actually refuses `people/...`. Removing it
 *     fails four tests.
 *   - the **`..` segment check** and the **containment check** are redundant
 *     for any path a marker can spell: removing either alone fails nothing,
 *     because the allowlist and the remaining one still cover it.
 *
 * They stay anyway, and deleting one on the grounds that another covers it is
 * the mistake this paragraph exists to prevent. Containment is the only guard
 * that survives a **symlinked root** — a vault whose `brain/` points into
 * another tree passes the allowlist by name while resolving outside it — and
 * the `..` check is the only one that reads as a refusal rather than as an
 * accident of path arithmetic. Neither is exercised by the suite, so treat
 * both as unverified rather than as proven.
 */
export function isExposed(vaultRoot: string, policy: ExposurePolicy, note: string): boolean {
	const rel = note.replace(/^[\\/]+/, "");
	const segments = rel.split(/[\\/]/);
	if (segments.some((s) => s === "..")) return false;

	const root = segments[0] ?? "";
	if (!root) return false;
	if (root.toLowerCase() === policy.memoryRoot.toLowerCase()) return false;
	if (!policy.roots.some((r) => r.toLowerCase() === root.toLowerCase())) return false;

	const full = resolve(join(vaultRoot, rel));
	const rootDir = resolve(join(vaultRoot, root));
	return full === rootDir || full.startsWith(rootDir + sep);
}

/** Strip frontmatter so an anchor cannot match inside it. */
function bodyOf(md: string): string {
	return md.replace(/^---[\s\S]*?\r?\n---\r?\n/, "");
}

/**
 * The block carrying `^id`.
 *
 * Obsidian puts the id at the end of a block, or alone on the line after it.
 * Both forms are handled, because a promoter writing by hand will produce
 * either. The returned text never includes the id itself — it is addressing,
 * not content, and a caller pasting it back into a note would create a
 * duplicate id.
 */
export function blockAt(md: string, id: string): string | null {
	const lines = bodyOf(md).split(/\r?\n/);
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const trailing = new RegExp(`\\s\\^${escaped}\\s*$`);
	const alone = new RegExp(`^\\s*\\^${escaped}\\s*$`);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (trailing.test(line)) {
			// The block is this line plus any lines that continue it: more-indented
			// or lazily-continued text belonging to the same list item or paragraph.
			const out = [line.replace(trailing, "")];
			for (let j = i + 1; j < lines.length; j++) {
				const next = lines[j] ?? "";
				if (!next.trim() || /^\s*[-*+]\s|^\s*#{1,6}\s/.test(next)) break;
				out.push(next);
			}
			return out.join("\n").trim() || null;
		}
		if (alone.test(line)) {
			// Walk back over the paragraph the id is attached to.
			const out: string[] = [];
			for (let j = i - 1; j >= 0; j--) {
				const prev = lines[j] ?? "";
				if (!prev.trim()) break;
				out.unshift(prev);
				if (/^\s*[-*+]\s|^\s*#{1,6}\s/.test(prev)) break;
			}
			return out.join("\n").trim() || null;
		}
	}
	return null;
}

/**
 * The section under a heading, up to the next heading of the same or higher
 * level. Matched on the heading's text rather than its level, so promoting
 * under `## X` and later deepening it to `### X` does not strand the marker.
 */
export function sectionAt(md: string, heading: string): string | null {
	const lines = bodyOf(md).split(/\r?\n/);
	const want = heading.trim().toLowerCase().replace(/\s+/g, " ");

	for (let i = 0; i < lines.length; i++) {
		const m = (lines[i] ?? "").match(/^(#{1,6})\s+(.+?)\s*$/);
		if (!m) continue;
		const text = (m[2] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
		if (text !== want) continue;

		const level = (m[1] ?? "").length;
		const out: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j] ?? "";
			const h = next.match(/^(#{1,6})\s+/);
			if (h && (h[1] ?? "").length <= level) break;
			out.push(next);
		}
		return out.join("\n").trim() || null;
	}
	return null;
}

/**
 * Resolve a capture's `promoted:` marker to the text a caller should read.
 *
 * Returns null when there is no marker at all, so a caller can tell "not
 * promoted" from "promoted but not servable" — those want different wording
 * and conflating them is how a stale pointer reads as an absent one.
 *
 * `cache` is per-CALL, never per-process, and both halves of that matter. One
 * recall can return twenty entries promoted into the same topic note, and
 * without it that note is read and split twenty times — the cost follows the
 * number of promoted memories rather than the number of distinct notes, which
 * is the wrong axis and the one that grows. Caching across calls instead would
 * serve a note the vault has since corrected, which is the exact failure this
 * whole mechanism exists to prevent, so the map dies with the response.
 *
 * A `null` value is cached too: an unreadable note is a fact worth remembering
 * for the rest of the call, and a missing entry re-`stat`s it per memory.
 */
export function resolvePromoted(
	vaultRoot: string,
	policy: ExposurePolicy,
	raw: unknown,
	cache?: Map<string, string | null>,
): PromotedResolution | null {
	const ref = parsePromotedMarker(raw);
	if (!ref) return null;
	if (!ref.anchor) return { status: "no-anchor", note: ref.note };
	if (!isExposed(vaultRoot, policy, ref.note)) return { status: "not-exposed", note: ref.note };

	let md: string | null;
	if (cache?.has(ref.note)) {
		md = cache.get(ref.note) ?? null;
	} else {
		const full = join(vaultRoot, ref.note);
		try {
			md = existsSync(full) ? readFileSync(full, "utf8") : null;
		} catch {
			md = null;
		}
		cache?.set(ref.note, md);
	}
	if (md === null) return { status: "unreadable", note: ref.note };

	const text = ref.kind === "block" ? blockAt(md, ref.anchor) : sectionAt(md, ref.anchor);
	if (!text) return { status: "stale-anchor", note: ref.note, anchor: ref.anchor };
	return { status: "served", note: ref.note, anchor: ref.anchor, text };
}
