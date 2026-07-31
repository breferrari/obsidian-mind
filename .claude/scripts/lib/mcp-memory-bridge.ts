/**
 * The seam between the memory core and the server.
 *
 * The core modules (`memory-write`, `memory-recall`, `memory-similarity`,
 * `memory-supersede`) are pure decisions about content. This file is where those
 * decisions meet a real vault: which names a link may resolve to, which
 * platforms the caller belongs to, and how the index reorders what the
 * visibility rule already allowed.
 *
 * Everything here was the site of at least one real defect, and each is called
 * out where it lives. They share a shape worth stating once: **a lookup scoped
 * to the wrong thing returns an empty answer, and an empty answer is the one
 * result this system cannot distinguish from a correct one.**
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
	readMemories,
	agentMemories,
	parseFrontmatter,
	type Facets,
	type MemoryEntry,
} from "./memory-recall.ts";
import { qmdRelKey, vaultRelKey, subQueries, type QmdClient } from "./mcp-qmd-client.ts";
import type { VisibleFile } from "./mcp-exposure.ts";
import { readHead, HEAD_CHARS } from "./read-head.ts";

export interface MemoryDigest extends Facets {
	readonly rel: string;
	readonly full: string;
	readonly title: string;
	readonly body: string;
}

/**
 * Every name a wikilink could legitimately resolve to.
 *
 * An MCP write bypasses the PostToolUse validation hook, so a guarantee the
 * vault normally enforces has to be re-implemented here: never emit a broken
 * link. The naive version breaks immediately — a project's note is
 * `projects/pocket/README.md`, so `[[pocket]]` resolves to nothing unless that
 * README declares `aliases: [pocket]`. Some vaults' do; a fresh vault's do not,
 * and the capture would manufacture a broken link every single time.
 *
 * Resolvable = a file basename, or any name in a file's frontmatter `aliases:`,
 * in either the block or the inline form. Same rule the vault's own wikilink
 * checker applies.
 */
/**
 * Undo a YAML scalar's quoting, rather than merely removing its quote marks.
 *
 * Stripping the outer quotes is not the same operation and differs on exactly
 * the values that need it. In a single-quoted scalar `''` is one literal quote,
 * so `'It''s here'` unquoted by character removal yields `It''s here` — a name
 * no wikilink will ever match, and one an author looking at the rendered note
 * would swear is present. In a double-quoted scalar the escapes are C-style,
 * so `\\` is one backslash.
 *
 * This matters more since captures began carrying their title as an alias: an
 * apostrophe is ordinary in a title and would otherwise silently cost the note
 * its only resolvable name.
 */
export function unquoteScalar(raw: string): string {
	const t = raw.trim();
	if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
		return t.slice(1, -1).replace(/''/g, "'");
	}
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
		return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	return t;
}

export function resolvableNames(files: readonly VisibleFile[]): Set<string> {
	const names = new Set<string>();
	for (const f of files) {
		names.add(f.label.toLowerCase());
		const head = readHead(f.full, HEAD_CHARS);
		if (head === null) continue; // an unreadable file still contributes its basename
		const block = head.match(/^aliases:\s*$([\s\S]*?)^(?=\S|---)/m);
		if (block?.[1]) {
			for (const line of block[1].split("\n")) {
				const m = line.match(/^\s*-\s*(.+?)\s*$/);
				if (m?.[1]) names.add(unquoteScalar(m[1]).toLowerCase());
			}
		}
		const inline = head.match(/^aliases:\s*\[(.*)\]\s*$/m);
		if (inline?.[1]) {
			for (const part of inline[1].split(",")) {
				const name = unquoteScalar(part).toLowerCase();
				if (name) names.add(name);
			}
		}
	}
	return names;
}

/** Load every agent-written memory with its facets, title and body. */
export function digestsFrom(entries: readonly MemoryEntry[]): MemoryDigest[] {
	return agentMemories(entries).map((m) => ({
		rel: m.rel,
		full: m.full,
		title: m.title ?? "",
		body: m.body,
		...m.facets,
	}));
}

/**
 * The same, read from disk. The IO wrapper.
 *
 * No production caller: the server reads through `memory-index`. This is the
 * on-disk oracle those cache tests assert equality against, so a dead-code sweep
 * that removes it takes the equivalence guarantee with it.
 */
export function loadMemoryDigests(vaultRoot: string, memoryRoot: string): MemoryDigest[] {
	return digestsFrom(readMemories(vaultRoot, memoryRoot));
}

/**
 * First markdown file in the vault whose basename matches `name`.
 *
 * Skips dot-directories, `node_modules` and the memory tree — a memory is never
 * a project note, and walking it would grow the cost with the store for no
 * benefit.
 */
export function findNoteNamed(vaultRoot: string, name: string, memoryRoot: string): string | null {
	const want = `${String(name).toLowerCase()}.md`;
	const stack: string[] = [vaultRoot];
	while (stack.length) {
		const dir = stack.pop();
		if (!dir) break;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === memoryRoot || e.name === "node_modules") continue;
				stack.push(full);
			} else if (e.isFile() && e.name.toLowerCase() === want) {
				return full;
			}
		}
	}
	return null;
}

/**
 * Which platforms the calling repo belongs to.
 *
 * Read from the project's own note rather than from server config, so the answer
 * lives where a human would naturally maintain it and no vault has to learn a
 * second place to declare things. A project with no note, or no `platforms:`
 * key, simply has no platform, and platform-scoped memories will not reach it —
 * the correct default for "unknown".
 *
 * TWO WRONG VERSIONS PRECEDED THIS, both failing the same silent way.
 *
 * The first looked in `projects/<caller>/README.md`. That is one vault's shape;
 * a clean install of this template has no `projects/` folder at all. Config
 * would not have saved it either — a key that must be set correctly per vault
 * is the same assumption with extra steps.
 *
 * The second matched on note identity but walked the EXPOSED files only. A
 * vault that keeps its projects in a folder outside `mcp_exposed_roots` (the
 * default does exactly that) silently returned no platform, so every
 * platform-scoped memory was withheld. It was caught only because `explain`
 * printed `platforms=[]`.
 *
 * The fix is a boundary correction rather than a wider allowlist: what platform
 * the CALLER belongs to is a property of the caller, not of what the vault
 * chooses to expose as readable content. So the search is vault-wide by
 * FILENAME, exactly one frontmatter key is read from the single matching file,
 * no note body is used, and nothing is returned to the caller except its own
 * platform list.
 *
 * A THIRD version was nearly shipped and caught in review. Reading only the
 * head — as the other frontmatter probes in this file do — looks like the same
 * optimisation, but it is not: those replaced an equally-sized character slice,
 * while this replaced a WHOLE-file read. `parseFrontmatter` needs the CLOSING
 * `---`, so a project note whose frontmatter runs past the head (a long
 * description, or aliases, both ordinary) parsed to `{}` and the caller got no
 * platforms — presenting exactly like the two failures above. This reads the
 * whole file on purpose: it is one file per call, next to a vault walk.
 */
export function callerPlatforms(vaultRoot: string, caller: string | null, memoryRoot: string): string[] {
	if (!caller) return [];
	const match = findNoteNamed(vaultRoot, caller.toLowerCase(), memoryRoot);
	if (!match) return [];
	try {
		const v = parseFrontmatter(readFileSync(match, "utf8")).platforms;
		if (Array.isArray(v)) return v.map(String).filter(Boolean);
		if (typeof v === "string" && v) return [v];
	} catch {
		/* unreadable — treat as no platform */
	}
	return [];
}

/**
 * Reorder already-visible memories by semantic relevance, through the index.
 *
 * RETRIEVE SEMANTICALLY, THEN FILTER BY VISIBILITY — never the reverse.
 *
 * The index sees every memory in the vault, including ones scoped to other
 * projects. Ranking by relevance first and applying the scope rule to the RESULT
 * keeps one implementation of that rule, so semantic recall returns exactly the
 * set plain recall would. Handing the index a pre-narrowed corpus would put a
 * second, subtly different rule in the query layer, and the two would drift.
 *
 * Returns null when the index cannot answer, so the caller falls back to lexical
 * matching. That fallback is the point: qmd is OPTIONAL in this template, and an
 * unavailable index must degrade recall to "worse ordering", never to "the vault
 * knows nothing", which is indistinguishable from having no memories at all.
 */
export async function semanticMemoryOrder<T extends { full: string }>(
	client: QmdClient,
	vaultRoot: string,
	query: string,
	visible: readonly T[],
	limit: number,
): Promise<T[] | null> {
	const byKey = new Map(visible.map((m) => [vaultRelKey(vaultRoot, m.full), m]));
	try {
		const out = (await client.call("tools/call", {
			name: "query",
			arguments: {
				searches: subQueries(query),
				intent: `durable lessons relevant to: ${query}`,
				limit: Math.max(limit * 3, 15),
				minScore: 0.3,
			},
		})) as { structuredContent?: { results?: unknown } } | null;

		const hits = out?.structuredContent?.results;
		if (!Array.isArray(hits) || hits.length === 0) return null;

		const ordered: T[] = [];
		const seen = new Set<string>();
		const placed = new Set<T>();
		for (const h of hits as { file?: string }[]) {
			const key = qmdRelKey(h.file);
			if (seen.has(key)) continue;
			seen.add(key);
			const m = byKey.get(key);
			// Absent from `byKey` means the scope rule already excluded it — it was
			// written for a different project. Skipped silently, because it is not
			// a result this caller asked about.
			if (m) {
				ordered.push(m);
				placed.add(m);
			}
		}
		if (!ordered.length) return null;

		// REORDER, never filter. The index ranks what it matched; everything else
		// the visibility rule allowed follows in its declared order. Returning only
		// the matches would DROP a visible memory from recall entirely — which is
		// what happens to one written moments ago, since a fresh note carries no
		// embedding until the index next embeds. A memory that exists, is in
		// scope, and cannot be recalled is the false negative this layer is for.
		return [...ordered, ...visible.filter((m) => !placed.has(m))];
	} catch {
		return null;
	}
}
