/**
 * Discovery and self-healing for the vault memory layer.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every hardcoded path and every config key in this layer is a promise the user
 * can break without knowing. They rename `memories/` in Obsidian; they
 * reorganise `brain/`; they move the vault folder; the template moves its own
 * scripts. Nothing errors — the server simply stops finding things, and
 * "returns nothing" is indistinguishable from "there is nothing", which is the
 * failure mode that cost the most time building this layer.
 *
 * So: DERIVE, don't declare. Config becomes an override for the rare case where
 * derivation is wrong, not the mechanism everything depends on. Where a value
 * genuinely cannot be derived, it gets reported by `health()` rather than
 * failing quietly.
 *
 * Modelled on this template's qmd bootstrap: detect current state, repair what
 * can be repaired, migrate from a legacy shape, stay idempotent, and say out
 * loud when it healed something.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { normalizePath } from "./mcp-caller.ts";
import { readHead } from "./read-head.ts";
import { MEMORY_SOURCE } from "./memory-write.ts";
import { join, relative, sep } from "node:path";

/** Directories never worth walking, in any vault. */
const SKIP = new Set([".git", ".obsidian", ".shardmind", "node_modules", ".claude", ".codex", ".gemini"]);

/**
 * Frontmatter that marks a file as agent-written, built from the one constant.
 *
 * Escaped because the value belongs to another module: a marker containing `.`
 * or `|` would quietly widen what counts as agent-written, and this regex is
 * what decides where the entire store is judged to live.
 */
const AGENT_WRITTEN = new RegExp(
	`^source:\\s*["']?${MEMORY_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`,
	"m",
);

/** How deep a memory tree can nest before we stop believing it is one. */
const MAX_DEPTH = 4;

export interface SplitRoot {
	readonly root: string;
	readonly memories: number;
}

export interface MemoryRootInfo {
	readonly root: string;
	readonly source: "configured" | "discovered";
	readonly memories: number;
	/** True when the notes disagree with config — the rename case. */
	readonly healed: boolean;
	readonly configured: string;
	/** Non-null when captures are spread across more than one folder. */
	readonly split: SplitRoot[] | null;
}

export interface ExposedRootsInfo {
	readonly roots: string[];
	readonly source: "manifest" | "fallback";
}

export interface QmdLauncherInfo {
	readonly path: string | null;
	readonly source: "expected" | "discovered" | "absent";
}

export interface OrphanedProject {
	readonly project: string;
	readonly memories: number;
}

export interface IndexPathInfo {
	readonly state: "unknown" | "registered" | "malformed" | "unregistered";
	readonly path: string | null;
}

export interface HealthReport {
	readonly memory: MemoryRootInfo;
	readonly exposed: ExposedRootsInfo;
	readonly qmd: QmdLauncherInfo;
	readonly orphans: OrphanedProject[];
	readonly warnings: string[];
	readonly notes: string[];
	readonly ok: boolean;
}

type Manifest = Record<string, unknown> | null | undefined;

/**
 * Walk markdown files, bounded. Shared by every discovery below so a vault is
 * traversed at most once per concern rather than once per question.
 */
export function walkMarkdown(root: string, { maxDepth = MAX_DEPTH }: { maxDepth?: number } = {}): string[] {
	const out: string[] = [];
	const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		const { dir, depth } = item;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
			} else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
				out.push(full);
			}
		}
	}
	return out;
}

/** Cheap frontmatter probe — reads only the head of a file, not all of it. */
export function probeFrontmatter(full: string, chars = 800): string | null {
	const head = readHead(full, chars);
	if (head === null) return null;
	const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return m ? (m[1] ?? null) : null;
}

/**
 * Where do memories actually live?
 *
 * Config is consulted first, but is NOT trusted blindly: a `memory_root`
 * pointing at a folder the user has since renamed would send new captures to a
 * fresh empty directory while the real ones sit unreachable — the store
 * silently forking in two.
 *
 * The authority is the notes themselves. `source: mcp-capture` is written by
 * this layer on every memory, so the folder containing the most of them IS the
 * memory root, whatever it has been renamed to. Only when none exist anywhere
 * does the configured (or default) value stand — the empty-vault case, where
 * there is nothing to be wrong about yet.
 */
export function discoverMemoryRoot(vaultRoot: string, configured = "memories"): MemoryRootInfo {
	const counts = new Map<string, number>();
	for (const full of walkMarkdown(vaultRoot)) {
		const fm = probeFrontmatter(full);
		if (!fm || !AGENT_WRITTEN.test(fm)) continue;
		const rel = relative(vaultRoot, full).split(sep);
		if (rel.length < 2) continue;
		const top = rel[0];
		if (!top) continue;
		counts.set(top, (counts.get(top) ?? 0) + 1);
	}

	if (counts.size === 0) {
		return {
			root: configured,
			source: "configured",
			memories: 0,
			healed: false,
			configured,
			split: null,
		};
	}

	let bestRoot = "";
	let bestCount = -1;
	for (const [root, n] of counts) {
		if (n > bestCount) {
			bestRoot = root;
			bestCount = n;
		}
	}

	return {
		root: bestRoot,
		source: bestRoot === configured ? "configured" : "discovered",
		memories: bestCount,
		// A discovered root that disagrees with config is the rename case. The
		// layer follows the notes, and says so — silently following either one is
		// how a store forks.
		healed: bestRoot !== configured,
		configured,
		// More than one folder holding captures means an incomplete move. Worth
		// naming, because retrieval will only ever see the larger half.
		split: counts.size > 1 ? [...counts.entries()].map(([r, c]) => ({ root: r, memories: c })) : null,
	};
}

/**
 * Which top-level folders hold user content?
 *
 * Derived from the manifest's own `user_content_roots`, which this template and
 * its derivatives already maintain for other purposes — so there is no new key
 * to keep correct, and a vault that reorganises updates one list it was already
 * updating.
 *
 * An earlier default of `["brain", "projects", "strategy", "reference"]` was one
 * specific vault's shape: a clean install has no `projects/` and no `strategy/`
 * at all, so resources came back empty and nothing said why.
 */
export function discoverExposedRoots(
	vaultRoot: string,
	manifest: Manifest,
	fallback: string[] = ["brain", "reference"],
): ExposedRootsInfo {
	const declared = Array.isArray(manifest?.user_content_roots) ? manifest.user_content_roots : [];
	const tops = new Set<string>();
	for (const entry of declared) {
		const top = String(entry)
			.replace(/^[./]+/, "")
			.split(/[/\\]/)[0];
		// Globs like `perf/h*-*/` contribute their literal first segment; a
		// leading-glob entry contributes nothing rather than everything.
		if (top && !top.includes("*")) tops.add(top);
	}
	const existing = [...tops].filter((t) => {
		try {
			return statSync(join(vaultRoot, t)).isDirectory();
		} catch {
			return false;
		}
	});
	if (existing.length) return { roots: existing, source: "manifest" };

	const present = fallback.filter((t) => existsSync(join(vaultRoot, t)));
	return { roots: present.length ? present : fallback, source: "fallback" };
}

/**
 * Locate the vault's qmd MCP launcher.
 *
 * Hardcoding `.claude/scripts/qmd-mcp.mjs` bets on a layout the template itself
 * is actively trying to change (#71 moves hook scripts). Searching for it by
 * name costs one bounded walk at startup and survives the move.
 *
 * Returns null when absent, which is a legitimate state — qmd is optional, and
 * the caller degrades to lexical rather than failing.
 */
export function discoverQmdLauncher(vaultRoot: string): QmdLauncherInfo {
	const preferred = join(vaultRoot, ".claude", "scripts", "qmd-mcp.mjs");
	if (existsSync(preferred)) return { path: preferred, source: "expected" };

	const stack: { dir: string; depth: number }[] = [{ dir: vaultRoot, depth: 0 }];
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		const { dir, depth } = item;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isFile() && e.name === "qmd-mcp.mjs") return { path: full, source: "discovered" };
			// Dotfolders ARE walked here: the launcher legitimately lives inside
			// one. Only the known-irrelevant ones are skipped.
			if (e.isDirectory() && depth < 3 && !SKIP.has(e.name) && e.name !== ".git") {
				stack.push({ dir: full, depth: depth + 1 });
			}
		}
	}
	return { path: null, source: "absent" };
}

/**
 * Memories naming a project that has no note in this vault.
 *
 * Deliberately NOT called "orphaned" to the user, and deliberately not an error.
 * Visibility matches a memory's `projects` against the CALLING REPO's name,
 * which does not require a note to exist — so a memory scoped to a repo you have
 * never written a note about still reaches that repo's sessions perfectly well.
 *
 * The first version of this reported such memories as reaching nobody. That was
 * simply false, and a diagnostic that lies is worse than no diagnostic: it sends
 * you looking for a fault that isn't there. What it is genuinely useful for is
 * spotting a REPO RENAME — memories still scoped to the old name — which shows
 * up here as a name nothing else in the vault refers to.
 *
 * Reported as information, never auto-fixed: rewriting a user's records on a
 * guess about their intent is not this layer's call.
 */
export function findOrphanedProjects(
	vaultRoot: string,
	memoryRoot: string,
	knownNames: Iterable<string>,
): OrphanedProject[] {
	const known = new Set([...knownNames].map((n) => String(n).toLowerCase()));
	const orphans = new Map<string, number>();
	const base = join(vaultRoot, memoryRoot);
	if (!existsSync(base)) return [];
	for (const full of walkMarkdown(base)) {
		const fm = probeFrontmatter(full, 1200);
		if (!fm) continue;
		const m = fm.match(/^projects:\s*\[(.*)\]\s*$/m);
		if (!m) continue;
		for (const raw of (m[1] ?? "").split(",")) {
			const name = raw.trim().replace(/^["']|["']$/g, "");
			if (!name) continue;
			if (known.has(name.toLowerCase())) continue;
			orphans.set(name, (orphans.get(name) ?? 0) + 1);
		}
	}
	return [...orphans.entries()].map(([project, memories]) => ({ project, memories }));
}

/**
 * Does this vault's search index actually belong to this vault?
 *
 * The failure this catches cost real time to diagnose by hand. A vault whose
 * `qmd_index` collides with another vault's — a shared literal, or two vaults
 * that happen to share a folder name — gets a collection registered against
 * SOMEONE ELSE'S directory. Re-indexing then faithfully updates the wrong tree,
 * search returns nothing from this vault, and every layer above it reports "no
 * results".
 *
 * Nothing errors anywhere in that chain. It is the same silent shape as every
 * other defect in this layer, and it is the last one left.
 *
 * qmd keeps one YAML per index under the user's config dir, of the shape:
 *
 *   collections:
 *     <name>:
 *       path: /path/to/some-vault
 *
 * Parsed with a line scan rather than a YAML dependency: we read exactly one
 * key, the file is machine-written, and a malformed read degrades to "unknown"
 * rather than to a wrong answer.
 *
 * `readFile` and `joinPath` are injected so this stays testable without touching
 * the real user config dir.
 */
export function readIndexPath(
	indexName: string | null | undefined,
	home: string,
	readFile: (path: string) => string,
	joinPath: (...parts: string[]) => string,
): IndexPathInfo {
	if (!indexName) return { state: "unknown", path: null };
	const candidates = [
		joinPath(home, ".config", "qmd", `${indexName}.yml`),
		joinPath(home, ".config", "qmd", `${indexName}.yaml`),
	];
	for (const file of candidates) {
		let text: string;
		try {
			text = readFile(file);
		} catch {
			continue;
		}
		// First `path:` under the collections block. One key, one scan.
		const m = text.match(/^\s*path:\s*(.+?)\s*$/m);
		if (m?.[1]) return { state: "registered", path: m[1].replace(/^["']|["']$/g, "") };
		return { state: "malformed", path: null };
	}
	return { state: "unregistered", path: null };
}

/** Case- and separator-insensitive path comparison, for Windows and POSIX alike. */
export function samePath(a: unknown, b: unknown): boolean {
	return normalizePath(a) === normalizePath(b);
}

/**
 * Verdict on the index wiring. Returns a warning string, or null when fine.
 *
 * `unregistered` is deliberately NOT a warning: a vault that has never run the
 * bootstrap is in a normal starting state, and the missing-launcher check
 * already covers the case where qmd is absent entirely.
 */
export function indexOwnershipWarning(
	indexName: string,
	vaultRoot: string,
	info: IndexPathInfo | null | undefined,
): string | null {
	if (!info || info.state === "unregistered") return null;
	if (info.state === "malformed") {
		return `Search index "${indexName}" has an unreadable config; index health cannot be confirmed.`;
	}
	if (info.state !== "registered" || !info.path) return null;
	if (samePath(info.path, vaultRoot)) return null;
	return (
		`Search index "${indexName}" is registered to a DIFFERENT vault (${info.path}). ` +
		"Re-indexing updates that tree, not this one, so memories and notes here will not be found. " +
		"Give this vault its own qmd_index in vault-manifest.json, then re-run the qmd bootstrap."
	);
}

/**
 * One call that answers "is this wiring actually intact?".
 *
 * Exists because every failure in this layer is silent by nature: a renamed
 * folder, a moved script, a stale index and an orphaned project all present
 * identically as "no results". Health turns each of them into a sentence.
 */
export function health(
	vaultRoot: string,
	manifest: Manifest,
	{
		knownNames = [],
		indexName = null,
		home = null,
	}: { knownNames?: Iterable<string>; indexName?: string | null; home?: string | null } = {},
): HealthReport {
	const configured = typeof manifest?.memory_root === "string" ? manifest.memory_root : "memories";
	const mem = discoverMemoryRoot(vaultRoot, configured);
	const exposed = discoverExposedRoots(vaultRoot, manifest);
	const qmd = discoverQmdLauncher(vaultRoot);
	const orphans = findOrphanedProjects(vaultRoot, mem.root, knownNames);

	const warnings: string[] = [];
	if (mem.healed) {
		warnings.push(
			`Memories are in "${mem.root}/" but the manifest says "${mem.configured}". Following the notes; set memory_root to "${mem.root}" to make it explicit.`,
		);
	}
	if (mem.split) {
		warnings.push(
			`Captures are split across ${mem.split.map((s) => `${s.root}/ (${s.memories})`).join(" and ")} — retrieval only sees "${mem.root}/". Move the rest.`,
		);
	}
	// An undeclared `mcp_exposed_roots` is not a warning: it means the server
	// serves the vault's own `user_content_roots`, which is the default and the
	// state most vaults should be in. Declaring the key narrows that.
	if (qmd.source === "absent") {
		warnings.push("qmd launcher not found — search and recall degrade to lexical matching.");
	}
	if (qmd.source === "discovered") {
		warnings.push(`qmd launcher found at an unexpected path (${qmd.path}); the layout moved.`);
	}
	// Does the index this vault writes to actually belong to this vault?
	if (indexName && home) {
		const info = readIndexPath(
			indexName,
			home,
			(f) => readFileSync(f, "utf8"),
			(...p) => join(...p),
		);
		const w = indexOwnershipWarning(indexName, vaultRoot, info);
		if (w) warnings.push(w);
	}
	// Kept out of `warnings` on purpose: this is not a fault. A repo needs no note
	// in the vault for its memories to reach it, so surfacing this as a problem
	// sends the reader hunting for a break that does not exist.
	const notes = orphans.map(
		(o) =>
			`${o.memories} memor${o.memories === 1 ? "y" : "ies"} scoped to "${o.project}", which has no note here. Normal if that repo simply has no note; worth checking if it was renamed.`,
	);

	return { memory: mem, exposed, qmd, orphans, warnings, notes, ok: warnings.length === 0 };
}
