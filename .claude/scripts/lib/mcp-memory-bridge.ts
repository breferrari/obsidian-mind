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

import { listMemoryFiles, parseFrontmatter, facetsOf, type Facets } from "./memory-recall.ts";
import { qmdRelKey, vaultRelKey, type QmdClient } from "./mcp-qmd-client.ts";
import type { VisibleFile } from "./mcp-exposure.ts";

const HEAD_BYTES = 1200;

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
export function resolvableNames(files: readonly VisibleFile[]): Set<string> {
	const names = new Set<string>();
	for (const f of files) {
		names.add(f.label.toLowerCase());
		let head: string;
		try {
			head = readFileSync(f.full, "utf8").slice(0, HEAD_BYTES);
		} catch {
			continue; // an unreadable file still contributes its basename
		}
		const block = head.match(/^aliases:\s*$([\s\S]*?)^(?=\S|---)/m);
		if (block?.[1]) {
			for (const line of block[1].split("\n")) {
				const m = line.match(/^\s*-\s*(.+?)\s*$/);
				if (m?.[1]) names.add(m[1].replace(/^["']|["']$/g, "").toLowerCase());
			}
		}
		const inline = head.match(/^aliases:\s*\[(.*)\]\s*$/m);
		if (inline?.[1]) {
			for (const part of inline[1].split(",")) {
				const name = part.trim().replace(/^["']|["']$/g, "").toLowerCase();
				if (name) names.add(name);
			}
		}
	}
	return names;
}

/** Load every agent-written memory with its facets, title and body. */
export function loadMemoryDigests(vaultRoot: string, memoryRoot: string): MemoryDigest[] {
	const out: MemoryDigest[] = [];
	for (const f of listMemoryFiles(vaultRoot, memoryRoot)) {
		let md: string;
		try {
			md = readFileSync(f.full, "utf8");
		} catch {
			continue;
		}
		const fm = parseFrontmatter(md);
		// Only agent-written memories participate. A human note that wandered in
		// here is left alone rather than silently governed by these rules.
		if (fm.source !== "mcp-capture") continue;
		const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
		const body = md
			.replace(/^---[\s\S]*?\r?\n---\r?\n/, "")
			.replace(/^#\s+.*$/m, "")
			.trim();
		out.push({ rel: f.rel, full: f.full, title, body, ...facetsOf(fm) });
	}
	return out;
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
 * no note body is opened, and nothing is returned to the caller except its own
 * platform list.
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
 * projects. Ranking by relevance first and applying visibility to the RESULT
 * keeps the fence in exactly one place, so semantic recall can never surface
 * anything the visibility rule would not already have allowed. Handing the index
 * a pre-narrowed corpus would put a second, subtly different fence in the query
 * layer, and the two would drift apart — which is how the search leak happened.
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
				searches: [
					{ type: "lex", query },
					{ type: "vec", query },
				],
				intent: `durable lessons relevant to: ${query}`,
				limit: Math.max(limit * 3, 15),
				minScore: 0.3,
			},
		})) as { structuredContent?: { results?: unknown } } | null;

		const hits = out?.structuredContent?.results;
		if (!Array.isArray(hits) || hits.length === 0) return null;

		const ordered: T[] = [];
		const seen = new Set<string>();
		for (const h of hits as { file?: string }[]) {
			const key = qmdRelKey(h.file);
			if (seen.has(key)) continue;
			seen.add(key);
			const m = byKey.get(key);
			// Absent from `byKey` means the visibility rule already excluded it.
			// Skipped silently and never counted aloud: naming a withheld memory —
			// even as a number — leaks what the scope rule exists to hide.
			if (m) ordered.push(m);
		}
		return ordered.length ? ordered : null;
	} catch {
		return null;
	}
}
