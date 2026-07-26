/**
 * The vault memory layer — retrieval.
 *
 * Deliberately a separate module from the write path. They have different
 * failure modes and different blast radii: a bad write costs one note, a bad
 * read leaks one project's context into another project's session. Keeping them
 * apart means the visibility rule can be reasoned about — and hammered — alone.
 *
 * THE PRECISION PROBLEM
 *
 * Retrieval has two failure modes pulling in opposite directions:
 *
 *   false positive — a memory from an unrelated project surfaces. The expensive
 *                    one: it is how a session gets "reminded" of a constraint
 *                    that does not apply, and how one client's context reaches
 *                    another's.
 *   false negative — a memory that would have helped stays hidden. Cheap in
 *                    isolation, but it is the entire value proposition; a memory
 *                    layer nobody's session ever sees is an expensive no-op.
 *
 * The resolution: reach is DECLARED at write time (`scope`) rather than guessed
 * at read time. A reader never widens what a writer declared.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_ROOT } from "./memory-write.ts";

export interface Facets {
	readonly scope: string;
	readonly projects: string[];
	readonly platforms: string[];
	readonly confidence: string;
	readonly flags: string[];
	readonly origin: string | null;
	readonly date: string | null;
	readonly superseded_by: string[];
	readonly source: string | null;
}

export interface Caller {
	readonly project?: string | null;
	readonly platforms?: readonly string[];
}

export interface MemoryEntry {
	readonly rel: string;
	readonly full: string;
	readonly facets: Facets;
	readonly title: string | null;
	readonly body: string;
	readonly why?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Parse the subset of YAML this layer writes. Not a general parser on purpose:
 * we own the writer, so supporting arbitrary YAML would be surface area with no
 * caller. Anything unrecognised is ignored rather than guessed at.
 *
 * Returns `{}` for a file with no frontmatter — such a file is simply not a
 * memory, and must not throw its way into a retrieval path.
 */
export function parseFrontmatter(md: unknown): Record<string, string | string[]> {
	const m = String(md ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: Record<string, string | string[]> = {};
	for (const line of (m[1] ?? "").split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		const key = kv[1]!;
		const raw = (kv[2] ?? "").trim();
		if (raw === "") continue;
		if (raw.startsWith("[") && raw.endsWith("]")) {
			const inner = raw.slice(1, -1).trim();
			out[key] = inner ? inner.split(",").map((p) => unquote(p.trim())).filter(Boolean) : [];
		} else {
			out[key] = unquote(raw);
		}
	}
	return out;
}

function unquote(s: string): string {
	const t = String(s).trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
		try {
			return JSON.parse(t) as string;
		} catch {
			return t.slice(1, -1);
		}
	}
	if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
	return t;
}

/** Normalize a parsed memory's facets so the visibility rule sees one shape. */
export function facetsOf(fm: Record<string, unknown> | null | undefined): Facets {
	const list = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter(Boolean).map(String) : v ? [String(v)] : [];
	const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
	return {
		scope: typeof fm?.scope === "string" ? fm.scope : "project",
		projects: list(fm?.projects),
		platforms: list(fm?.platforms),
		confidence: typeof fm?.confidence === "string" ? fm.confidence : "unverified",
		flags: list(fm?.flags),
		origin: str(fm?.origin),
		date: str(fm?.date),
		superseded_by: list(fm?.superseded_by),
		source: str(fm?.source),
	};
}

// ---------------------------------------------------------------------------
// Visibility — the precision rule
// ---------------------------------------------------------------------------

const eq = (a: unknown, b: unknown): boolean => String(a).toLowerCase() === String(b).toLowerCase();
const overlaps = (a: readonly string[], b: readonly string[]): boolean =>
	a.some((x) => b.some((y) => eq(x, y)));

/**
 * Is this memory visible to this caller? Evaluated in order, and the ORDER is
 * the design:
 *
 *   1. `general` reaches everyone. The only scope that does, which is why
 *      write-side narrowing polices it so hard.
 *   2. An explicit project listing always wins. If a memory names your project
 *      you see it, regardless of its declared scope — this is what makes the
 *      multi-project case work: `projects: [a, b]` reaches both, and neither has
 *      to know the other exists.
 *   3. `platform` scope reaches any caller sharing a platform. The "same
 *      platform, different project" case: an iOS lesson learned in one app
 *      should reach the next iOS app and must NOT reach the web one.
 *   4. Otherwise: not visible. Default deny — a memory with no matching facet
 *      stays put rather than leaking on a near-miss.
 *
 * A caller with no identity (no MCP roots) sees only `general`. That is the
 * safest reading of "I don't know who you are", and it degrades to useless
 * rather than to wide-open.
 */
export function isVisibleTo(facets: Facets | null | undefined, caller: Caller | null | undefined): boolean {
	const f = facets;
	const project = caller?.project ?? null;
	const platforms = Array.isArray(caller?.platforms) ? caller.platforms : [];

	if (f?.scope === "general") return true;
	if (project && (f?.projects ?? []).some((p) => eq(p, project))) return true;
	if (f?.scope === "platform" && overlaps(f?.platforms ?? [], platforms)) return true;
	return false;
}

/**
 * Why a memory was or was not shown.
 *
 * Retrieval that cannot explain itself is impossible to debug and impossible to
 * trust — and every failure in this layer presents identically as "no results".
 * This string is what tells a renamed folder apart from an empty vault.
 */
export function visibilityReason(facets: Facets | null | undefined, caller: Caller | null | undefined): string {
	const f = facets;
	const project = caller?.project ?? null;
	const platforms = Array.isArray(caller?.platforms) ? caller.platforms : [];

	if (f?.scope === "general") return "general scope reaches every caller";
	if (project && (f?.projects ?? []).some((p) => eq(p, project))) {
		return `explicitly lists project "${project}"`;
	}
	if (f?.scope === "platform" && overlaps(f?.platforms ?? [], platforms)) {
		return `platform scope overlaps caller platforms [${platforms.join(", ")}]`;
	}
	if (!project && platforms.length === 0) {
		return "caller has no identity; only general memories are visible";
	}
	return `no facet matches caller (project="${project}", platforms=[${platforms.join(", ")}])`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Specificity first, then recency.
 *
 * A memory naming your project is more likely to matter than one that happens to
 * share a platform, which in turn beats a general one. Ranking by relevance
 * alone would bury the precise hit under the broad ones exactly when the caller
 * needs it most.
 */
export function specificity(facets: Facets | null | undefined, caller: Caller | null | undefined): number {
	const project = caller?.project ?? null;
	if (project && (facets?.projects ?? []).some((p) => eq(p, project))) {
		// A memory naming ONLY your project is more specific than one naming five.
		return 100 - Math.min(20, (facets?.projects ?? []).length);
	}
	if (facets?.scope === "platform") return 50;
	if (facets?.scope === "general") return 10;
	return 0;
}

/**
 * Superseded memories sink rather than disappear: the correction is what you
 * want, but the history is occasionally what you need.
 */
export function rankMemories<T extends { facets: Facets }>(entries: readonly T[], caller: Caller): T[] {
	return [...entries].sort((a, b) => {
		const supA = a.facets.superseded_by.length > 0 ? 1 : 0;
		const supB = b.facets.superseded_by.length > 0 ? 1 : 0;
		if (supA !== supB) return supA - supB;
		const s = specificity(b.facets, caller) - specificity(a.facets, caller);
		if (s !== 0) return s;
		return String(b.facets.date ?? "").localeCompare(String(a.facets.date ?? ""));
	});
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/** Walk the memory tree. Shallow by design: `root/YYYY/MM/*.md`, nothing deeper. */
export function listMemoryFiles(vaultRoot: string, root: string = MEMORY_ROOT): { rel: string; full: string }[] {
	const base = join(vaultRoot, root);
	if (!existsSync(base)) return [];
	const out: { rel: string; full: string }[] = [];
	for (const year of safeDirs(base)) {
		for (const month of safeDirs(join(base, year))) {
			const dir = join(base, year, month);
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (name.endsWith(".md")) out.push({ rel: `${root}/${year}/${month}/${name}`, full: join(dir, name) });
			}
		}
	}
	return out;
}

function safeDirs(dir: string): string[] {
	try {
		return readdirSync(dir).filter((n) => {
			try {
				return statSync(join(dir, n)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
}

/**
 * Load every memory visible to this caller, ranked.
 *
 * `explain` attaches the visibility reason to each entry AND returns the
 * withheld ones with theirs — used to prove a memory was excluded deliberately
 * rather than missed by accident.
 */
export function recall(
	vaultRoot: string,
	caller: Caller,
	opts?: { root?: string; explain?: false },
): MemoryEntry[];
export function recall(
	vaultRoot: string,
	caller: Caller,
	opts: { root?: string; explain: true },
): { visible: MemoryEntry[]; withheld: MemoryEntry[] };
export function recall(
	vaultRoot: string,
	caller: Caller,
	{ root = MEMORY_ROOT, explain = false }: { root?: string; explain?: boolean } = {},
): MemoryEntry[] | { visible: MemoryEntry[]; withheld: MemoryEntry[] } {
	const visible: MemoryEntry[] = [];
	const withheld: MemoryEntry[] = [];
	for (const file of listMemoryFiles(vaultRoot, root)) {
		let md: string;
		try {
			md = readFileSync(file.full, "utf8");
		} catch {
			continue; // an unreadable file must not take down retrieval
		}
		const fm = parseFrontmatter(md);
		// Only agent-written memories participate; a human note that wandered in
		// here is left alone rather than silently governed by these rules.
		if (fm.source !== "mcp-capture") continue;
		const facets = facetsOf(fm);
		// The body travels with the entry. A caller past the visibility rule has
		// earned the content, and the memory root is not in the resource-exposure
		// list anyway — so a pointer-only result hands back a path it cannot open.
		const entry: MemoryEntry = { ...file, facets, title: titleOf(md), body: bodyOf(md) };
		if (isVisibleTo(facets, caller)) {
			visible.push(explain ? { ...entry, why: visibilityReason(facets, caller) } : entry);
		} else if (explain) {
			withheld.push({ ...entry, why: visibilityReason(facets, caller) });
		}
	}
	const ranked = rankMemories(visible, caller);
	return explain ? { visible: ranked, withheld } : ranked;
}

function titleOf(md: string): string | null {
	const m = md.match(/^#\s+(.+)$/m);
	return m ? (m[1] ?? "").trim() : null;
}

/** The note minus its frontmatter and H1 — the part worth carrying. */
function bodyOf(md: string): string {
	return md
		.replace(/^---[\s\S]*?\r?\n---\r?\n/, "")
		.replace(/^#\s+.*$/m, "")
		.trim();
}
