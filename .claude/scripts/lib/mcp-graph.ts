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
 * WHERE SCOPING BITES HARDER HERE THAN IN SEARCH
 *
 * Backlinks are computed ONLY over notes the caller may already see. Otherwise
 * "what links to X" discloses the existence and the titles of notes the fence
 * just refused to show — a listing leak dressed up as a graph query. Outbound
 * links get the same treatment from the other side: a link pointing somewhere
 * out of scope is COUNTED but never NAMED, which is honest about the graph
 * being bigger than the view without saying what is in the rest of it.
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

	const hit =
		files.find((f) => f.label.toLowerCase() === want) ??
		files.find((f) => f.full.toLowerCase().replace(/\\/g, "/").endsWith(`/${want}.md`)) ??
		resolveVisible(files, seed);

	if (!hit) {
		// A near-miss list is only built from VISIBLE notes, so the suggestion
		// itself cannot disclose something the fence withheld.
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

	// Split outbound into what can actually be served and what exists but sits
	// outside this caller's scope. Naming the latter would leak; counting it is
	// honest without disclosing what it is.
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
