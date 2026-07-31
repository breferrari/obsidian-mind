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

/**
 * And the same bound in BYTES, because lines are not a size.
 *
 * One bullet of 240,000 characters is a single line, so it passed the line cap
 * untouched and was reported as complete. This repo's own note-size rule says
 * the unit is "bytes, not lines — giant single-line entries hide in low line
 * counts", and that is exactly what happened here. The capture body this text
 * REPLACES is warned at 8,000 characters, so without a byte bound the
 * substitution could be thirty times the thing it substitutes.
 */
const MAX_SERVED_CHARS = 8_000;

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
	/**
	 * The anchor no longer resolves — the block was renamed, moved or removed.
	 *
	 * Carries `kind` for the same reason `served` does: the renderer spells the
	 * anchor back to the caller, and a heading is `#Text` rather than `#^Text`.
	 * The served branch was fixed for this and the stale branch was not, so the
	 * reference a caller was told to go and check did not resolve.
	 */
	| {
			readonly status: "stale-anchor";
			readonly note: string;
			readonly anchor: string;
			readonly kind: "block" | "heading";
	  }
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
 * Keyed on the RESOLVED PATH, so one key is one file on every platform. A
 * lowercased marker was tried first and conflated two genuinely different files
 * on Linux, where case matters — a duplicate read traded for content crossing.
 */
export type NoteCache = Map<string, string[] | null>;

/** What a finder returns: the text, and whether a cap trimmed it. */
export interface Cut {
	readonly text: string;
	readonly truncated: boolean;
}

/** A fenced code block delimiter — ``` or ~~~, any length, any info string. */
const FENCE = /^\s*(?:>\s?)*(`{3,}|~{3,})\s*([^`]*)$/;

/** A trailing `^id`, which registers the block it sits in. */
const TRAILING_ID = /(?:^|\s)\^([A-Za-z0-9][\w-]*)\s*$/;

/** A line holding nothing but an id, which attaches to the block above it. */
const ALONE_ID = /^[\s>|]*\^([A-Za-z0-9][\w-]*)\s*$/;

/** Blockquote depth, counted off the line's leading `>` run. */
const depthOf = (line: string): number => (line.match(/^\s*((?:>\s?)*)/)?.[1]?.match(/>/g) ?? []).length;

/** The line with its blockquote scaffolding removed. */
const unquote = (line: string): string => line.replace(/^\s*(?:>\s?)*/, "");

/**
 * Does this line begin a new block regardless of what precedes it?
 *
 * The predecessor was `/^\s*[-*+]\s|^\s*#{1,6}\s/` — bullets and headings, and
 * nothing else. An ordered list was invisible to it, so a promoted list item
 * served itself and every sibling after it, reported as complete.
 */
function startsBlock(bare: string): boolean {
	return (
		/^#{1,6}\s/.test(bare) ||
		/^[-*+]\s/.test(bare) ||
		/^\d+[.)]\s/.test(bare) ||
		/^\|/.test(bare) ||
		/^<[a-zA-Z!/]/.test(bare) ||
		/^(?:-{3,}|_{3,}|\*{3,})\s*$/.test(bare)
	);
}

/** One addressable run of lines. `to` is exclusive. */
interface Block {
	readonly from: number;
	to: number;
	readonly depth: number;
	/** Whether the id that registered this block sat on its last line. */
	idAtEnd: boolean;
}

export interface Segmented {
	readonly byId: ReadonlyMap<string, Block>;
	readonly headings: readonly { readonly line: number; readonly level: number; readonly text: string }[];
}

/**
 * Split a note into blocks and index every id, in one pass.
 *
 * **This replaced two regexes and two directional walks, and the reason is the
 * point.** The old shape classified a LINE — `trailing` for an id at the end of
 * one, `alone` for an id on its own — and then walked outward to guess the
 * block's extent: forward from a trailing id, backward from an alone one.
 * Which block a line belongs to is not a property of that line, so the walks
 * were compensating for information the design never computed.
 *
 * The two branches encoded OPPOSITE assumptions — trailing meant "the id starts
 * this block, extend forward", alone meant "the id ends it, extend backward" —
 * so a fix to one could not reach the other. Two audit rounds each found a
 * high-severity defect and each patched one branch; a third found both defects
 * still live in the branch that had not been touched. Over 90 enumerated cases
 * the walking design answered 11 wrong.
 *
 * The defect that mattered was not exotic. `om-tidy` documents putting the id
 * **at the end of the bullet or paragraph**, which is what Obsidian does — and
 * the trailing branch assumed the id's line was the block's FIRST. Measured on
 * a real note: a two-line bullet served one line, dropping the rule's own
 * subject, and reported `truncated: false`.
 *
 * A block here is a maximal run of non-blank lines at one blockquote depth in
 * one container. A line holding only an id does not start a block; it attaches
 * to the one that just ended, which is the "id on the following line" form.
 * Fences are tracked in the same pass rather than by a separate mask, which is
 * also what makes it cheaper — the mask used to be rebuilt per anchor, so cost
 * followed the number of promoted memories rather than the number of notes.
 */
export function segment(lines: readonly string[]): Segmented {
	const byId = new Map<string, Block>();
	const headings: { line: number; level: number; text: string }[] = [];
	let fence: { char: string; len: number; quote: number } | null = null;
	let open: Block | null = null;
	let previous: Block | null = null;

	const close = (): void => {
		if (open) {
			previous = open;
			open = null;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const quote = depthOf(line);
		const bare = unquote(line);
		const f = line.match(FENCE);

		if (fence) {
			if (f?.[1] && f[1][0] === fence.char && f[1].length >= fence.len && quote === fence.quote) fence = null;
			if (open) open.to = i + 1;
			continue;
		}
		if (f?.[1]) {
			fence = { char: f[1][0] ?? "`", len: f[1].length, quote };
			if (open) open.to = i + 1;
			else open = { from: i, to: i + 1, depth: quote, idAtEnd: false };
			continue;
		}

		if (!bare.trim()) {
			close();
			continue;
		}

		const solo = bare.match(ALONE_ID);
		if (solo?.[1]) {
			const target = open ?? previous;
			if (target) {
				if (open) open.to = i;
				target.idAtEnd = true;
				// FIRST occurrence wins. `set` let a later duplicate silently
				// replace an earlier one, which is a different note than the
				// reader is looking at.
				if (!byId.has(solo[1])) byId.set(solo[1], target);
			}
			close();
			continue;
		}

		if (!open || quote !== open.depth || startsBlock(bare)) {
			close();
			open = { from: i, to: i + 1, depth: quote, idAtEnd: false };
		} else {
			open.to = i + 1;
			// A line after the id-bearing one means the id is no longer at the end.
			open.idAtEnd = false;
		}

		const h = bare.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (h?.[1] && h[2]) {
			headings.push({ line: i, level: h[1].length, text: h[2] });
			close();
			continue;
		}

		const trailing = line.match(TRAILING_ID);
		if (trailing?.[1] && open) {
			open.idAtEnd = true;
			if (!byId.has(trailing[1])) byId.set(trailing[1], open);
		}
	}

	return { byId, headings };
}

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
function capped(input: readonly string[], total = input.length): { text: string; truncated: boolean } {
	// Blank edges are stripped BEFORE the cap rather than trimmed after it.
	// Counting them toward the budget and then trimming them away meant a
	// section of 39 content lines reported TRUNCATED with nothing real dropped:
	// the blank after a heading ate a slot and the trailing blank tripped the
	// flag. That teaches a caller to distrust a complete answer, and it made
	// the effective cap 39 rather than 40.
	let from = 0;
	let to = input.length;
	while (from < to && !(input[from] ?? "").trim()) from++;
	while (to > from && !(input[to - 1] ?? "").trim()) to--;
	const lines = input.slice(from, to);
	// A caller that already sliced (the backward walk keeps its tail) reports
	// the loss it took, so truncation stays honest.
	const preSliced = total - input.length;

	const kept = lines.length > MAX_SERVED_LINES ? lines.slice(0, MAX_SERVED_LINES) : lines;
	let truncated = preSliced > 0 || lines.length > kept.length;
	let text = kept.join("\n").trim();
	// Lines are not a size. One bullet of 240,000 characters is a single line and
	// sailed through the line cap reported as complete, while the capture body it
	// REPLACES is warned at 8,000 characters.
	if (text.length > MAX_SERVED_CHARS) {
		text = `${text.slice(0, MAX_SERVED_CHARS).trimEnd()}…`;
		truncated = true;
	}
	return { text, truncated };
}

/**
 * The block carrying `^id` — a lookup, not a walk.
 *
 * The segmenter already decided which lines the block spans, so there is no
 * direction left to get wrong. That is the whole reason the shape changed.
 */
export function blockAtLines(lines: readonly string[], id: string, doc: Segmented = segment(lines)): Cut | null {
	const block = doc.byId.get(id);
	if (!block) return null;
	const body = lines
		.slice(block.from, block.to)
		.map((l) => l.replace(TRAILING_ID, ""))
		.filter((l) => !ALONE_ID.test(l));
	if (!body.length) return null;
	// Cap toward the END THE ID IS ON. Capping from the head loses the anchored
	// line when the id closes the block; capping from the tail loses the entry's
	// opening when it starts it. Over the same enumerated cases: head 86,
	// tail 87, id-side 88.
	const c =
		block.idAtEnd && body.length > MAX_SERVED_LINES
			? capped(body.slice(-MAX_SERVED_LINES), body.length)
			: capped(body);
	return c.text ? c : null;
}

/**
 * The section under a heading, up to the next heading of the same or higher
 * level. Matched on the heading's TEXT rather than its level, so promoting
 * under `## X` and later deepening it to `### X` does not strand the marker.
 *
 * A level-1 heading is skipped rather than fatal: a note can carry both
 * `# Alpha` and `## Alpha`, and refusing on the first text match made the
 * legitimate H2 unreachable — behaviour that depended on document order. In
 * this vault's shape the H1 is the note's own title, so `#Some Note` would
 * address the whole note through an anchor that looks specific.
 */
export function sectionAtLines(lines: readonly string[], heading: string, doc: Segmented = segment(lines)): Cut | null {
	const want = heading.trim().toLowerCase().replace(/\s+/g, " ");
	for (let h = 0; h < doc.headings.length; h++) {
		const here = doc.headings[h];
		if (!here || here.level === 1) continue;
		if (here.text.trim().toLowerCase().replace(/\s+/g, " ") !== want) continue;
		let end = lines.length;
		for (let j = h + 1; j < doc.headings.length; j++) {
			const next = doc.headings[j];
			if (next && next.level <= here.level) {
				end = next.line;
				break;
			}
		}
		const c = capped(lines.slice(here.line + 1, end));
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
	return resolvePromotedRef(vaultRoot, policy, parsePromotedMarker(raw), cache);
}

/**
 * The same resolution, for a caller holding an already-parsed marker.
 *
 * `facetsOf` parses at read time so the marker format has ONE definition (see
 * `Facets.promoted`). Re-deriving the ref here would restore the second one that
 * change exists to remove, and the two would drift the moment either is edited.
 */
export function resolvePromotedRef(
	vaultRoot: string,
	policy: ExposurePolicy,
	ref: PromotedRef | null,
	cache: NoteCache = new Map(),
): PromotedResolution | null {
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
		if (ref.note.split(/[\/]/).includes("..") || !isExposedPath(policy, ref.note)) {
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
	if (!hit) return { status: "stale-anchor", note: ref.note, anchor: ref.anchor, kind: ref.kind };
	return {
		status: "served",
		note: ref.note,
		anchor: ref.anchor,
		kind: ref.kind,
		text: hit.text,
		truncated: hit.truncated,
	};
}

// ---------------------------------------------------------------------------
// Store-wide audit
// ---------------------------------------------------------------------------

/** One capture, as much of it as an audit needs. Structural on purpose: */
/* importing MemoryEntry would make memory-recall → memory-promoted a cycle. */
export interface PromotedAuditable {
	readonly path: string;
	readonly facets: { readonly promoted: PromotedRef | null; readonly promotedRaw: string | null };
}

/** A promotion that names a note but cannot serve it. */
export interface BrokenPromotion {
	/** Store-relative path of the CAPTURE, which is the file to edit. */
	readonly path: string;
	readonly note: string;
	readonly status: "stale-anchor" | "not-exposed" | "unreadable";
}

export interface PromotionAudit {
	/** Markers that resolve to text. */
	readonly served: number;
	/** Bare `promoted: <note>` — legitimate, and deliberately not a warning. */
	readonly namedOnly: number;
	/** Present in frontmatter, rejected by the parser. */
	readonly unparsed: readonly string[];
	readonly broken: readonly BrokenPromotion[];
}

/**
 * Resolve every promotion in the store, so the party that can FIX a broken one
 * is the party that hears about it.
 *
 * The diagnostic already existed and only the recall renderer consumed it, which
 * put it in front of the one reader who cannot act: a foreign repo sees
 * `stale-anchor` and cannot see `brain/` at all. Meanwhile a vault session edits
 * a topic note, drops a `^om-…` id, and every recall elsewhere silently
 * downgrades to the raw capture body with nobody in the vault told. (#183)
 *
 * A bare marker is NOT broken. Promotion is additive and serving is a separate,
 * deliberate act — treating "named only" as a defect would push anchors onto
 * captures whose promoted block is not fit to leave the vault, which is the
 * disclosure risk the opt-in design is careful about. It is counted, not warned.
 */
export function auditPromotions(
	vaultRoot: string,
	policy: ExposurePolicy,
	entries: readonly PromotedAuditable[],
): PromotionAudit {
	// One cache for the whole sweep: a store with forty captures promoted into
	// six topic notes reads six files, not forty. Scoped to this call for the
	// same reason the recall cache is — a correction between two health calls
	// must never be served from the earlier one.
	const cache: NoteCache = new Map();
	const broken: BrokenPromotion[] = [];
	const unparsed: string[] = [];
	let served = 0;
	let namedOnly = 0;

	for (const e of entries) {
		if (e.facets.promoted === null) {
			// Declared but unparseable — a control character, a non-string. Worth
			// naming: the marker is invisible to every consumer, so from the vault's
			// side the capture looks unpromoted while the frontmatter says otherwise.
			if (e.facets.promotedRaw !== null) unparsed.push(e.path);
			continue;
		}
		const r = resolvePromotedRef(vaultRoot, policy, e.facets.promoted, cache);
		if (r === null) continue;
		if (r.status === "served") served++;
		else if (r.status === "no-anchor") namedOnly++;
		else broken.push({ path: e.path, note: r.note, status: r.status });
	}

	return { served, namedOnly, unparsed, broken };
}
