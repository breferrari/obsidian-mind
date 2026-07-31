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
 * Three properties make that safe:
 *
 *   1. **Opt-in by construction.** Content is served only when the marker
 *      carries an ANCHOR. A bare `promoted: brain/Note` keeps the old
 *      behaviour. Anchors are written by the promotion step, so pointing at a
 *      block is a deliberate act rather than an automatic consequence of the
 *      marker existing — and every capture promoted before this shipped keeps
 *      today's behaviour until someone re-points it.
 *   2. **The exposure policy still bounds every read**, and it is asked rather
 *      than re-derived. See the warning below.
 *   3. **It degrades rather than guesses.** A stale anchor returns the reason,
 *      never the whole note. Returning a `Gotchas` note because one bullet in
 *      it was promoted is worse than returning nothing, and it is the failure
 *      mode that made "what is the unit?" the hard question.
 *
 * > **Why there is no exposure check in this file.** There was one, and it was
 * > wrong in both directions: it dropped `neverExpose` and `isPrivate`, so it
 * > served two classes of note that every other surface withholds, and it
 * > compared the FIRST path segment against roots that are prefixes, so it
 * > refused most of the vault's own declared roots (`work/active/`,
 * > `perf/brag/`, `org/people/` are all multi-segment). Every test passed: the
 * > fixture policy was `["brain", "projects"]`, which is not the shape a real
 * > policy has.
 * >
 * > `resolveExposedNote` in `mcp-exposure.ts` is the one answer to "may this
 * > path be read out of the vault", and this module asks it. A second predicate
 * > is precisely the recurring defect that module exists to prevent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExposurePolicy, resolveExposedNote } from "./mcp-exposure.ts";
import { escapeRegex } from "./regex.ts";

/** A parsed `promoted:` marker. */
export interface PromotedRef {
	/** Vault-relative note path, always ending in `.md`. */
	readonly note: string;
	/** Block id (without `^`), heading text, or null for a bare note reference. */
	readonly anchor: string | null;
	readonly kind: "block" | "heading" | "note";
}

export type PromotedResolution =
	/**
	 * The promoted text, which is what the caller should read instead.
	 *
	 * `kind` travels with it because the renderer has to spell the anchor back
	 * to the caller, and the two forms are addressed differently — `#^id` for a
	 * block, `#Heading` for a section. Dropping it made a heading promotion
	 * report as `Note.md#^Some Heading`, a reference the caller cannot use.
	 */
	| {
			readonly status: "served";
			readonly note: string;
			readonly anchor: string;
			readonly kind: "block" | "heading";
			readonly text: string;
	  }
	/** A bare marker: named, never served. The pre-existing behaviour. */
	| { readonly status: "no-anchor"; readonly note: string }
	/** The policy does not serve this note. Named, never served. */
	| { readonly status: "not-exposed"; readonly note: string }
	/** The anchor no longer resolves — the block was renamed, moved or removed. */
	| { readonly status: "stale-anchor"; readonly note: string; readonly anchor: string }
	/** The note is gone or unreadable. */
	| { readonly status: "unreadable"; readonly note: string };

/**
 * A note's body, split into lines — the unit everything below works on.
 *
 * The cache holds LINES rather than raw text, because the read was already free
 * once a cache existed and the split was what remained. Measured at N=60
 * entries against an 82KB note: caching text 5.17ms, caching lines 1.84ms, and
 * 1.02ms with the substring prefilter in `blockAtLines`. `null` means not
 * servable, which is worth remembering for the rest of the call so a withheld
 * or missing note is not re-checked per memory.
 */
export type NoteCache = Map<string, string[] | null>;

/** Where a block ends: the next list item or heading. */
const BLOCK_BOUNDARY = /^\s*[-*+]\s|^\s*#{1,6}\s/;

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
	// the exposure check and reports as withheld — a misleading answer to a
	// question nobody asked. `facetsOf` already narrows to string, so this is
	// the second gate rather than the only one.
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

/** Strip frontmatter so an anchor cannot match inside it, then split. */
function bodyLines(md: string): string[] {
	return md.replace(/^---[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n/);
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
export function blockAtLines(lines: readonly string[], id: string): string | null {
	// A substring prefilter before either regex. The regexes are cheap to
	// compile and expensive to RUN — two `.test()` per line over a 1500-line
	// note at N=60 is ~183k executions — and nearly every line fails on the
	// literal `^id` alone. This is what takes the phase from 1.84ms to 1.02ms.
	const needle = `^${id}`;
	const escaped = escapeRegex(id);
	const trailing = new RegExp(`\\s\\^${escaped}\\s*$`);
	const alone = new RegExp(`^\\s*\\^${escaped}\\s*$`);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (!line.includes(needle)) continue;
		if (trailing.test(line)) {
			// The block is this line plus any lines that continue it: more-indented
			// or lazily-continued text belonging to the same list item or paragraph.
			const out = [line.replace(trailing, "")];
			for (let j = i + 1; j < lines.length; j++) {
				const next = lines[j] ?? "";
				if (!next.trim() || BLOCK_BOUNDARY.test(next)) break;
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
				if (BLOCK_BOUNDARY.test(prev)) break;
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
export function sectionAtLines(lines: readonly string[], heading: string): string | null {
	const want = heading.trim().toLowerCase().replace(/\s+/g, " ");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// Cheap reject before the regex: a heading line starts with `#`.
		if (line.charCodeAt(0) !== 35) continue;
		const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
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

/** Document-input wrappers, so a caller holding text need not pre-split. */
export const blockAt = (md: string, id: string): string | null => blockAtLines(bodyLines(md), id);
export const sectionAt = (md: string, heading: string): string | null => sectionAtLines(bodyLines(md), heading);

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
 * It takes a default rather than being optional: the one production caller
 * always passes a shared map, and an `undefined` cache would be a second code
 * path that only tests ever take.
 */
export function resolvePromoted(
	vaultRoot: string,
	policy: ExposurePolicy,
	raw: unknown,
	cache: NoteCache = new Map(),
): PromotedResolution | null {
	const ref = parsePromotedMarker(raw);
	if (!ref) return null;
	if (ref.anchor === null || ref.kind === "note") return { status: "no-anchor", note: ref.note };

	// Withheld and missing are told apart only for the message, and only on the
	// failure path: a reader can act on a marker pointing somewhere the policy
	// withholds, and cannot act on one pointing at a note that is simply gone.
	const refused = (): PromotedResolution =>
		existsSync(join(vaultRoot, ref.note))
			? { status: "not-exposed", note: ref.note }
			: { status: "unreadable", note: ref.note };

	let lines: string[] | null;
	if (cache.has(ref.note)) {
		lines = cache.get(ref.note) ?? null;
	} else {
		// The policy decides, once per distinct note rather than once per entry.
		// A null cache entry means "not servable" for either reason, so the
		// verdict is memoised alongside the content.
		const full = resolveExposedNote(vaultRoot, policy, ref.note);
		try {
			lines = full === null ? null : bodyLines(readFileSync(full, "utf8"));
		} catch {
			lines = null;
		}
		cache.set(ref.note, lines);
	}
	if (lines === null) return refused();

	const text = ref.kind === "block" ? blockAtLines(lines, ref.anchor) : sectionAtLines(lines, ref.anchor);
	if (!text) return { status: "stale-anchor", note: ref.note, anchor: ref.anchor };
	return { status: "served", note: ref.note, anchor: ref.anchor, kind: ref.kind, text };
}
