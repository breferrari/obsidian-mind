/**
 * The vault memory layer — retrieval.
 *
 * Deliberately a separate module from the write path. They have different
 * failure modes: a bad write costs one note, while a bad read puts another
 * project's context into this session and is acted on as if it applied. Keeping
 * them apart means the visibility rule can be reasoned about — and hammered —
 * alone.
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
import { MEMORY_ROOT, MEMORY_SOURCE } from "./memory-write.ts";
import { parsePromotedMarker, type PromotedRef } from "./memory-promoted.ts";

// Re-exported so a reader can take the marker from the module it reads with,
// while the writer that stamps it stays the one place it is defined.
export { MEMORY_SOURCE };

export interface Facets {
	readonly scope: string;
	readonly projects: string[];
	readonly platforms: string[];
	readonly confidence: string;
	readonly flags: string[];
	readonly origin: string | null;
	readonly date: string | null;
	/** ISO timestamp of the write; breaks ties within a day. */
	readonly session: string | null;
	readonly superseded_by: string[];
	readonly source: string | null;
	/**
	 * The `brain/` note this capture was promoted into, if any.
	 *
	 * `recall` reads only the memory root and `search`/`expand` see everything
	 * but, so the two surfaces are disjoint: a promoted lesson exists twice, and
	 * a foreign repo can only ever reach this copy. That copy is the raw capture,
	 * which may predate a correction the promoted version has already had swept
	 * through it.
	 *
	 * Since v8.3.0 an ANCHORED marker closes that gap: `resolvePromotedRef` serves
	 * the promoted block itself, through the capture that still declares the
	 * reach. A bare `promoted: <note>` keeps the older behaviour of naming the
	 * corrected version without serving it, which stays legitimate — serving is a
	 * separate and deliberate act, and requiring an anchor would push one onto
	 * captures whose promoted block is not fit to leave the vault.
	 *
	 * **Parsed here so the marker format has ONE definition.** It had three — this
	 * field as a raw string, `parsePromotedMarker`, and a regex in
	 * `active-hygiene.ts` — and three parsers for one format drift the moment any
	 * one of them is edited. (#183)
	 */
	readonly promoted: PromotedRef | null;
	/**
	 * The marker exactly as written, kept because `null` above is ambiguous.
	 *
	 * A capture with NO marker and a capture whose marker the parser REJECTED — a
	 * stray control character, a non-string — both parse to `null`, and only the
	 * second is a defect worth reporting. After the parse there is nothing left to
	 * tell them apart, so the raw string is carried alongside.
	 */
	readonly promotedRaw: string | null;
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
		session: str(fm?.session),
		superseded_by: list(fm?.superseded_by),
		source: str(fm?.source),
		promoted: parsePromotedMarker(fm?.promoted),
		promotedRaw: str(fm?.promoted),
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
 *      stays put rather than surfacing on a near-miss.
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
		const byDate = String(b.facets.date ?? "").localeCompare(String(a.facets.date ?? ""));
		if (byDate !== 0) return byDate;
		// `date` is day-granular, so same-day memories would otherwise sort
		// arbitrarily and a just-written one could fall outside the caller's limit
		// entirely. `session` is the ISO timestamp of the write.
		return String(b.facets.session ?? "").localeCompare(String(a.facets.session ?? ""));
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
		// Dirents answer isDirectory() from the listing itself, so an ordinary
		// folder costs no stat — and this runs on every read of the store.
		//
		// A symlink still needs one. `Dirent` reports a link-to-directory as
		// isSymbolicLink() and NOT isDirectory(), so filtering on isDirectory()
		// alone silently skips it: every memory under `memories/2025 -> /archive`
		// disappears from recall, from the duplicate scan and from `health`, with
		// no warning anywhere. The stat is paid only for links.
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => {
				if (e.isDirectory()) return true;
				if (!e.isSymbolicLink()) return false;
				try {
					return statSync(join(dir, e.name)).isDirectory();
				} catch {
					return false; // broken link
				}
			})
			.map((e) => e.name);
	} catch {
		return [];
	}
}

/**
 * Parse one file from the store.
 *
 * The single parse implementation, so the cache in `memory-index.ts` and a cold
 * read cannot drift into producing different entries from the same bytes.
 */
export function parseMemory(rel: string, full: string, md: string): MemoryEntry {
	const heading = md.match(/^#\s+(.+)$/m);
	return {
		rel,
		full,
		facets: facetsOf(parseFrontmatter(md)),
		title: heading ? (heading[1] ?? "").trim() : null,
		// The body travels with the entry. A caller past the visibility rule has
		// earned the content, and the memory root is not in the resource-exposure
		// list anyway — so a pointer-only result hands back a path it cannot open.
		body: md
			.replace(/^---[\s\S]*?\r?\n---\r?\n/, "")
			.replace(/^#\s+.*$/m, "")
			.trim(),
	};
}

/**
 * Read and parse one file from the store, or null if it cannot be read.
 *
 * Shared by the cold path below and by the cache in `memory-index.ts`, so the
 * two cannot drift on what counts as unreadable.
 */
export function readMemoryFile(file: { rel: string; full: string }): MemoryEntry | null {
	try {
		return parseMemory(file.rel, file.full, readFileSync(file.full, "utf8"));
	} catch {
		return null; // an unreadable file must not take down retrieval
	}
}

/** Read and parse the whole store. The uncached path. */
export function readMemories(vaultRoot: string, root: string = MEMORY_ROOT): MemoryEntry[] {
	const out: MemoryEntry[] = [];
	for (const file of listMemoryFiles(vaultRoot, root)) {
		const entry = readMemoryFile(file);
		if (entry) out.push(entry);
	}
	return out;
}

/**
 * The subset of a store that is agent-written.
 *
 * A human note that wandered into the memory folder is left alone rather than
 * silently governed by these rules. One predicate, so "what counts as a memory"
 * is answered in a single place.
 */
export function agentMemories(entries: readonly MemoryEntry[]): MemoryEntry[] {
	return entries.filter((m) => m.facets.source === MEMORY_SOURCE);
}

/**
 * Apply the visibility rule and rank what survives. PURE — no filesystem.
 *
 * This is the whole of recall's decision-making. `recall` below is the thin IO
 * wrapper that feeds it from disk; the server feeds it from its parse cache.
 *
 * Taking a pre-parsed list as an OPTIONAL argument alongside `vaultRoot` and
 * `root` was designed and rejected: it left both of those dead on every
 * production call, and made it possible to hand in entries read from one root
 * while naming another, with nothing able to notice.
 *
 * `explain` attaches the visibility reason to each entry AND returns the
 * withheld ones with theirs — used to prove a memory was excluded deliberately
 * rather than missed by accident.
 */
export function recallFrom(
	entries: readonly MemoryEntry[],
	caller: Caller,
	opts?: { explain?: false },
): MemoryEntry[];
export function recallFrom(
	entries: readonly MemoryEntry[],
	caller: Caller,
	opts: { explain: true },
): { visible: MemoryEntry[]; withheld: MemoryEntry[] };
export function recallFrom(
	entries: readonly MemoryEntry[],
	caller: Caller,
	{ explain = false }: { explain?: boolean } = {},
): MemoryEntry[] | { visible: MemoryEntry[]; withheld: MemoryEntry[] } {
	const visible: MemoryEntry[] = [];
	const withheld: MemoryEntry[] = [];
	for (const entry of agentMemories(entries)) {
		const facets = entry.facets;
		if (isVisibleTo(facets, caller)) {
			visible.push(explain ? { ...entry, why: visibilityReason(facets, caller) } : entry);
		} else if (explain) {
			withheld.push({ ...entry, why: visibilityReason(facets, caller) });
		}
	}
	const ranked = rankMemories(visible, caller);
	return explain ? { visible: ranked, withheld } : ranked;
}

/**
 * Load every memory visible to this caller, ranked. The IO wrapper.
 *
 * No production caller: the server reads through `memory-index`. This is the
 * on-disk oracle those cache tests assert equality against, so a dead-code sweep
 * that removes it takes the equivalence guarantee with it.
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
	const entries = readMemories(vaultRoot, root);
	return explain ? recallFrom(entries, caller, { explain: true }) : recallFrom(entries, caller);
}
