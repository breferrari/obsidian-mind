/**
 * Graph traversal — `expand`.
 *
 * WHY THIS IS NOT JUST ANOTHER SEARCH
 *
 * Searching and expanding from a known node are different operations, and
 * conflating them wastes turns: a session that already has the relevant note
 * should not have to re-describe it as a query and hope the index agrees. The
 * vault is already a wikilink graph, so following it is nearly free — no model
 * call, no embedding, just reading what is already written down.
 *
 * SCOPING APPLIES ON BOTH DIRECTIONS OF THE EDGE
 *
 * Backlinks are computed only over served notes, so `expand` and `search` agree
 * on which notes exist rather than reaching them by different routes. Outbound
 * links get the same treatment from the other side: a link pointing outside the
 * served set is COUNTED but not NAMED, which is honest about the graph being
 * larger than the view without listing the rest of it.
 */

import { readFileSync } from "node:fs";

import { firstDescription, type VisibleFile } from "./mcp-exposure.ts";

/** `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` — capture the target. */
const WIKILINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;

/** How many suggestions to offer when a seed matches nothing. */
const NEAR_MISS_LIMIT = 5;

export interface ExpandResult {
	readonly text: string;
	/** Null when the seed matched no visible note. */
	readonly note: VisibleFile | null;
	readonly outbound: string[];
	readonly inbound: string[];
	/** Outbound links that exist but point outside the caller's scope. */
	readonly hiddenOutbound: number;
}

/**
 * Normalise any way a caller might refer to a note into one comparable key.
 *
 * OBSERVED FAILURE, and the reason this is not just `toLowerCase()`: `search`
 * returns the index's paths, which flatten spaces to dashes, and the model fed
 * those straight into a resource read that only accepted its own URI form. Both
 * reads failed. Two namespaces for the same notes means a search hit cannot be
 * followed into a read, which defeats the point of exposing both surfaces.
 *
 * So: accept a URI, an index path, a repo-relative path or a bare title, and
 * compare with separators, case, and word punctuation normalised away.
 */
export function normalizeKey(s: unknown): string {
	let decoded = String(s ?? "");
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		/* a stray % is not a reason to fail the lookup */
	}
	const tail = decoded
		.replace(/^vault:\/\/(?:note\/)?/, "")
		.replace(/\.md$/i, "")
		.split(/[\\/]/)
		.pop();
	return (tail ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Resolve a caller-supplied reference to exactly one visible note.
 *
 * Ambiguity returns null rather than guessing. Two notes that normalise to the
 * same key are a real possibility across folders, and picking one silently
 * would hand back the wrong note's content with no signal that it happened.
 */
export function resolveVisible(files: readonly VisibleFile[], uriOrPath: unknown): VisibleFile | null {
	const key = normalizeKey(uriOrPath);
	if (!key) return null;
	const matches = files.filter((f) => normalizeKey(f.label) === key);
	return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Every wikilink target in a body, de-duplicated, in first-seen order. */
export function outboundLinks(body: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of String(body).matchAll(WIKILINK)) {
		const target = (m[1] ?? "").trim();
		if (!target) continue;
		const key = target.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(target);
	}
	return out;
}

function read(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * Expand a note into its neighbourhood.
 *
 * Cost note: computing backlinks reads every visible file, so this is O(n) in
 * vault size per call. Measured fine at present scale and tracked for an index
 * (#159) before it is not — but the read is deliberately not cached here,
 * because a stale graph that looks fresh is worse than a slow one.
 */
export function expandNote(files: readonly VisibleFile[], seed: string): ExpandResult {
	const want = String(seed ?? "")
		.replace(/\.md$/i, "")
		.toLowerCase();

	// Candidates are COLLECTED before one is chosen. Using `find` here took the
	// first match, which silently returned the wrong note whenever two visible
	// notes shared a basename — exactly what resolveVisible refuses to do, so
	// the module's own rule was broken by its primary path.
	const byLabel = files.filter((f) => f.label.toLowerCase() === want);
	const byPath = files.filter((f) => f.full.toLowerCase().replace(/\\/g, "/").endsWith(`/${want}.md`));
	const candidates = byLabel.length ? byLabel : byPath;

	if (candidates.length > 1) {
		// Naming the folders is safe — every candidate is already visible to this
		// caller — and it is the only way they can disambiguate, since the seed
		// they have is by definition not specific enough.
		const where = candidates.map((f) => `${f.scope}/${f.label}`).join("; ");
		return {
			text: `"${seed}" matches ${candidates.length} visible notes: ${where}. Pass a path rather than a title to choose one.`,
			note: null,
			outbound: [],
			inbound: [],
			hiddenOutbound: 0,
		};
	}

	const hit = candidates[0] ?? resolveVisible(files, seed);

	if (!hit) {
		// The near-miss list is built from served notes only, so a suggestion
		// always points at something the caller can actually open.
		const near = files
			.filter((f) => f.label.toLowerCase().includes(want) && want.length > 0)
			.slice(0, NEAR_MISS_LIMIT)
			.map((f) => f.label);
		return {
			text: `No visible note matches "${seed}".${near.length ? ` Did you mean: ${near.join("; ")}?` : ""}`,
			note: null,
			outbound: [],
			inbound: [],
			hiddenOutbound: 0,
		};
	}

	const outbound = outboundLinks(read(hit.full));
	const visibleLabels = new Set(files.map((f) => f.label.toLowerCase()));

	const inbound: string[] = [];
	for (const f of files) {
		if (f.full === hit.full) continue;
		for (const m of read(f.full).matchAll(WIKILINK)) {
			if ((m[1] ?? "").trim().toLowerCase() === hit.label.toLowerCase()) {
				inbound.push(f.label);
				break;
			}
		}
	}

	// Split outbound into what can actually be served and what the note links to
	// but sits outside the served set. Counting the latter tells the caller the
	// graph continues; naming it would offer a target `expand` cannot follow.
	const servable = outbound.filter((o) => visibleLabels.has(o.toLowerCase()));
	const hiddenOutbound = outbound.length - servable.length;

	const text = [
		`# ${hit.label}  (${hit.scope})`,
		firstDescription(hit.full),
		"",
		`## Links out (${servable.length} visible${hiddenOutbound ? `, ${hiddenOutbound} outside your scope` : ""})`,
		servable.length ? servable.map((s) => `- ${s}`).join("\n") : "- (none visible)",
		"",
		`## Linked from (${inbound.length})`,
		inbound.length ? inbound.map((s) => `- ${s}`).join("\n") : "- (none visible)",
	].join("\n");

	return { text, note: hit, outbound: servable, inbound, hiddenOutbound };
}
