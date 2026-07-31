/**
 * Serving a promoted lesson through the capture that still declares its reach.
 *
 * `recall` read only the memory root and `search`/`expand` see everything but,
 * so the two surfaces were disjoint. A lesson promoted into `brain/` therefore
 * exists twice, and a foreign repo could only reach the capture — the version
 * as first written, which may predate a correction swept through the promoted
 * one.
 *
 * The design turns on one fact that only became true in v8.2.0: **promotion is
 * additive, so the capture never leaves.** That means the capture is still the
 * reach record and it is already correct, and nothing about `scope`, `projects`
 * or `platforms` has to migrate onto an ordinary note. Visibility is computed
 * exactly as before; only the CONTENT served changes.
 *
 * Four properties make that safe:
 *
 *   1. **Opt-in by construction.** Content is served only when the marker
 *      carries an ANCHOR. A bare `promoted: brain/Note` keeps the old
 *      behaviour, so every capture promoted before this shipped is unaffected
 *      until someone re-points it.
 *   2. **The exposure policy still bounds every read**, and it is asked rather
 *      than re-derived. See the warning below.
 *   3. **It degrades rather than guesses.** A stale anchor returns the reason,
 *      never the whole note.
 *   4. **Everything served is BOUNDED.** An anchor addresses a block or a
 *      section, and both are capped — see `MAX_SERVED_LINES`. The mechanism
 *      exists to hand back one corrected entry, so a marker that would return
 *      a whole topic note has missed its own point.
 *
 * > **Why there is no exposure check in this file.** There was one, and it was
 * > wrong in both directions: it dropped `neverExpose` and `isPrivate`, so it
 * > served two classes of note that every other surface withholds, and it
 * > compared the FIRST path segment against roots that are prefixes, so it
 * > refused most of the vault's own declared roots. Every test passed: the
 * > fixture policy was `["brain", "projects"]`, which is not the shape a real
 * > policy has.
 * >
 * > `resolveExposedNote` in `mcp-exposure.ts` is the one answer to "may this
 * > path be read out of the vault", and this module asks it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExposurePolicy, isExposedPath, resolveExposedNote } from "./mcp-exposure.ts";
import { escapeRegex } from "./regex.ts";

/**
 * The most lines any single anchor may serve.
 *
 * A promoted entry is one bullet or one short section. Without a cap, two
 * shapes return the whole note: a heading anchor pointed at the H1 (measured:
 * 300 bullets, 8,979 characters), and a block whose continuation runs into an
 * unbroken wall of text. Both defeat property 4 above, and the second is
 * reachable by editing the target note rather than the marker — so the bound
 * belongs here rather than in the promoter's judgement.
 */
const MAX_SERVED_LINES = 40;

/** A parsed `promoted:` marker. */
export type PromotedRef =
	/** A bare note reference. Named to the caller, never served. */
	| { readonly note: string; readonly anchor: null; readonly kind: "note" }
	/** An anchored reference, which is the only servable form. */
	| { readonly note: string; readonly anchor: string; readonly kind: "block" | "heading" };

export type PromotedResolution =
	/**
	 * The promoted text, which is what the caller should read instead.
	 *
	 * `kind` travels with it because the renderer has to spell the anchor back
	 * to the caller, and the two forms are addressed differently — `#^id` for a
	 * block, `#Heading` for a section.
	 */
	| {
			readonly status: "served";
			readonly note: string;
			readonly anchor: string;
			readonly kind: "block" | "heading";
			readonly text: string;
			/** True when the cap trimmed it, so the caller is told it is partial. */
			readonly truncated: boolean;
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
 * servable, remembered for the rest of the call so a withheld or missing note
 * is not re-checked per memory.
 *
 * Keyed case-INSENSITIVELY: `brain/Note` and `brain/note` are one file on the
 * filesystems this runs on, and separate keys meant a second read and — worse —
 * two contradictory verdicts for one file inside a single response.
 */
export type NoteCache = Map<string, string[] | null>;

/** Where a block ends: the next list item or heading. */
const BLOCK_BOUNDARY = /^\s*[-*+]\s|^\s*#{1,6}\s/;

/** A fenced code block delimiter — ``` or ~~~, any length, any info string. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Newlines, carriage returns, escapes and the rest of C0/C1.
 *
 * Built from escapes rather than written literally, because a literal control
 * character in a character class is invisible in review and one attempt at this
 * silently compiled to the range space-to-space.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");

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
	// question nobody asked.
	if (typeof raw !== "string") return null;

	// A newline in a marker is a forged response, not a path.
	//
	// The recall renderer demotes a memory's BODY headings so that `##` in the
	// response means "entry title". The facet line is built from this string and
	// was not demoted, so a marker containing `\n\n## FORGED ENTRY` added a
	// seventh entry to a six-memory response, indistinguishable from a real one
	// — prompt injection into the context of whatever agent called `recall`.
	// Control characters go with it: they can rewrite a terminal line.
	if (CONTROL_CHARS.test(raw)) return null;

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
 * Strip frontmatter so an anchor cannot match inside it, then split.
 *
 * The BOM is removed FIRST. `^---` is anchored at byte zero, so a file saved
 * with a byte-order mark — which Windows editors do routinely — failed the
 * strip entirely, and the frontmatter then became addressable content: an
 * unquoted value ending in `^om-id` was served as a block.
 */
function bodyLines(md: string): string[] {
	return md
		.replace(/^﻿/, "")
		.replace(/^---[\s\S]*?\r?\n---\r?\n/, "")
		.split(/\r?\n/);
}

/** Cap a run of lines, reporting whether anything was dropped. */
function capped(lines: readonly string[]): { text: string; truncated: boolean } {
	const truncated = lines.length > MAX_SERVED_LINES;
	const kept = truncated ? lines.slice(0, MAX_SERVED_LINES) : lines;
	return { text: kept.join("\n").trim(), truncated };
}

/**
 * Lines that are inside a fenced code block.
 *
 * Computed once per note rather than tracked per scan, because both finders
 * need it and the note is already in memory. Without it a documentation
 * EXAMPLE hijacks the anchor: `om-tidy.md` teaches block ids inside fenced
 * blocks, so a `brain/` note about this very feature carries decoys, and the
 * first `^om-a1b2c3` found was the one inside the fence. The same shape lets a
 * `# Not a heading` inside a fence terminate a section early.
 */
function fencedMask(lines: readonly string[]): boolean[] {
	const mask: boolean[] = new Array(lines.length).fill(false);
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const m = (lines[i] ?? "").match(FENCE);
		if (fence === null) {
			if (m?.[1]) {
				fence = m[1][0] ?? "`";
				mask[i] = true;
			}
		} else {
			mask[i] = true;
			if (m?.[1] && m[1][0] === fence) fence = null;
		}
	}
	return mask;
}

/**
 * The block carrying `^id`.
 *
 * Obsidian puts the id at the end of a block, or alone on the line after it.
 * Both forms are handled, because a promoter writing by hand will produce
 * either. The returned text never includes the id itself — it is addressing,
 * not content, and a caller pasting it back would create a duplicate id.
 */
export function blockAtLines(lines: readonly string[], id: string): { text: string; truncated: boolean } | null {
	// A substring prefilter before either regex. The regexes are cheap to
	// compile and expensive to RUN — two `.test()` per line over a 1500-line
	// note at N=60 is ~183k executions — and nearly every line fails on the
	// literal `^id` alone. This is what takes the phase from 1.84ms to 1.02ms.
	const needle = `^${id}`;
	const escaped = escapeRegex(id);
	const trailing = new RegExp(`\\s\\^${escaped}\\s*$`);
	const alone = new RegExp(`^\\s*\\^${escaped}\\s*$`);
	const fenced = fencedMask(lines);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (fenced[i] || !line.includes(needle)) continue;
		if (trailing.test(line)) {
			// The block is this line plus any lines that continue it: more-indented
			// or lazily-continued text belonging to the same list item or paragraph.
			const out = [line.replace(trailing, "")];
			for (let j = i + 1; j < lines.length && out.length <= MAX_SERVED_LINES; j++) {
				const next = lines[j] ?? "";
				if (!next.trim() || BLOCK_BOUNDARY.test(next) || FENCE.test(next) || /^\s*[>|]/.test(next)) break;
				out.push(next);
			}
			const c = capped(out);
			return c.text ? c : null;
		}
		if (alone.test(line)) {
			// Walk back over the paragraph the id is attached to.
			const out: string[] = [];
			for (let j = i - 1; j >= 0 && out.length <= MAX_SERVED_LINES; j--) {
				const prev = lines[j] ?? "";
				if (!prev.trim()) break;
				out.unshift(prev);
				if (BLOCK_BOUNDARY.test(prev)) break;
			}
			const c = capped(out);
			return c.text ? c : null;
		}
	}
	return null;
}

/**
 * The section under a heading, up to the next heading of the same or higher
 * level. Matched on the heading's text rather than its level, so promoting
 * under `## X` and later deepening it to `### X` does not strand the marker.
 *
 * A level-1 heading is REFUSED. In this vault's shape the H1 is the note's own
 * title, so `#Some Note` addresses the entire note — which is the outcome
 * property 4 exists to prevent, reached by an anchor that looks specific.
 */
export function sectionAtLines(lines: readonly string[], heading: string): { text: string; truncated: boolean } | null {
	const want = heading.trim().toLowerCase().replace(/\s+/g, " ");
	const fenced = fencedMask(lines);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// Cheap reject before the regex: a heading line starts with `#`.
		if (fenced[i] || line.charCodeAt(0) !== 35) continue;
		const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (!m) continue;
		const text = (m[2] ?? "").trim().toLowerCase().replace(/\s+/g, " ");
		if (text !== want) continue;

		const level = (m[1] ?? "").length;
		if (level === 1) return null; // the note's own title is not a section
		const out: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j] ?? "";
			if (!fenced[j]) {
				const h = next.match(/^(#{1,6})\s+/);
				if (h && (h[1] ?? "").length <= level) break;
			}
			out.push(next);
		}
		const c = capped(out);
		return c.text ? c : null;
	}
	return null;
}

/** Document-input wrappers, so a caller holding text need not pre-split. */
export const blockAt = (md: string, id: string): string | null => blockAtLines(bodyLines(md), id)?.text ?? null;
export const sectionAt = (md: string, heading: string): string | null =>
	sectionAtLines(bodyLines(md), heading)?.text ?? null;

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
 */
export function resolvePromoted(
	vaultRoot: string,
	policy: ExposurePolicy,
	raw: unknown,
	cache: NoteCache = new Map(),
): PromotedResolution | null {
	const ref = parsePromotedMarker(raw);
	if (!ref) return null;
	if (ref.anchor === null) return { status: "no-anchor", note: ref.note };


	// Withheld and missing are told apart for the message only: a reader can act
	// on a marker pointing somewhere the policy withholds, and cannot act on one
	// pointing at a note that is simply gone.
	//
	// The `existsSync` that distinguishes them runs ONLY for a path already
	// inside a declared root with no traversal in it, so it cannot answer a
	// question about anything outside the vault. Statting unconditionally made
	// the status an out-of-vault existence oracle: `join` collapses `..`, so
	// `brain/../../secret` reported `not-exposed` when that file existed and
	// `unreadable` when it did not, and both answers reached the caller and the
	// audit log.
	const refused = (): PromotedResolution => {
		if (ref.note.includes("..") || !isExposedPath(policy, ref.note)) {
			return { status: "not-exposed", note: ref.note };
		}
		return existsSync(join(vaultRoot, ref.note))
			? { status: "not-exposed", note: ref.note }
			: { status: "unreadable", note: ref.note };
	};

	// The policy is asked every time; only the READ is cached. It is a few
	// syscalls against a read-and-split of a note that can be 82KB, and it is
	// what produces the cache key — see below.
	const full = resolveExposedNote(vaultRoot, policy, ref.note);
	if (full === null) return refused();

	// KEYED ON THE REALPATH, which is the file's identity, rather than on the
	// marker string.
	//
	// Keying on a lowercased marker was correct on Windows and macOS and wrong
	// on Linux, where `brain/Foo.md` and `brain/foo.md` are two different files:
	// the lowercased key conflated them, so one note's content could be served
	// for the other. That is worse than the duplicate read the lowercasing was
	// there to avoid, and only the Linux leg of CI could see it — both local
	// platforms are case-insensitive.
	//
	// A realpath is not a canonical identity either — `realpathSync` on Windows
	// echoes the caller's case rather than the name on disk, so two spellings of
	// one file still produce two entries there. That is a duplicate READ, which
	// is a cost; it is not two answers, which would be a bug. The property that
	// matters is the one the key now guarantees on every platform: **one key is
	// one file**, so no entry can ever serve another file's content. Collapsing
	// the remaining duplicate would need a `dev`+`ino` identity, and `ino` is not
	// dependable on Windows — not worth trading a correctness guarantee for.
	let lines = cache.get(full);
	if (lines === undefined) {
		try {
			lines = bodyLines(readFileSync(full, "utf8"));
		} catch {
			lines = null;
		}
		cache.set(full, lines);
	}
	if (lines === null) return refused();

	const hit = ref.kind === "block" ? blockAtLines(lines, ref.anchor) : sectionAtLines(lines, ref.anchor);
	if (!hit) return { status: "stale-anchor", note: ref.note, anchor: ref.anchor };
	return {
		status: "served",
		note: ref.note,
		anchor: ref.anchor,
		kind: ref.kind,
		text: hit.text,
		truncated: hit.truncated,
	};
}
