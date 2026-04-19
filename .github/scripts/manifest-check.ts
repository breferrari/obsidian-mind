#!/usr/bin/env node
/**
 * PR-time advisory: verify that every tracked template-infrastructure file
 * is covered by a glob in vault-manifest.json's `infrastructure` array.
 *
 * Emits GitHub workflow `::warning::` annotations for uncovered files. Does
 * not fail the job — this is an informational nudge to keep the manifest in
 * sync when new template files land.
 */

import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "../../.claude/scripts/lib/main-guard.ts";

type Manifest = { readonly infrastructure?: readonly string[] };

/**
 * Convert a glob pattern to a full-match regex.
 * Grammar: `**` matches any characters (including `/`); `*` matches any
 * run of non-slash characters; every other character is matched literally
 * (with regex metacharacters escaped).
 */
export function globToRegex(glob: string): RegExp {
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				pattern += ".*";
				i += 1; // consume second *
			} else {
				pattern += "[^/]*";
			}
		} else if (ch && /[.+^${}()|[\]\\]/.test(ch)) {
			pattern += "\\" + ch;
		} else {
			pattern += ch;
		}
	}
	return new RegExp(`^${pattern}$`);
}

/**
 * Return true if `path` is covered by any entry in `globs`. Exact-string
 * globs (no wildcards) are matched literally; wildcard globs go through
 * globToRegex.
 */
export function isCovered(
	path: string,
	globs: readonly string[],
): boolean {
	for (const g of globs) {
		if (g === path) return true;
		if (g.includes("*") && globToRegex(g).test(path)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Main — walks the watched directories and reports uncovered files.
// ---------------------------------------------------------------------------

// Top-level files in these directories are the "template infrastructure"
// surface. Each entry contributes every matching file in the directory.
const WATCHED: ReadonlyArray<{
	readonly dir: string;
	readonly exts: readonly string[];
}> = [
	{ dir: ".claude/commands", exts: [".md"] },
	{ dir: ".claude/agents", exts: [".md"] },
	{ dir: ".claude/scripts", exts: [".ts", ".json"] },
	{ dir: ".claude-plugin", exts: [".json"] },
	{ dir: ".codex", exts: [".json", ".md"] },
	{ dir: ".gemini", exts: [".json", ".md"] },
	{ dir: "templates", exts: [".md"] },
	{ dir: "bases", exts: [".base"] },
];

// Specific root-level files that are template infrastructure. Unlike the
// dir-walks above, the root has mixed concerns (infrastructure files live
// alongside user-content directories like work/ and brain/), so we allowlist
// the known infrastructure files by name. This list must stay in sync with
// the corresponding entries in vault-manifest.json's `infrastructure` array.
const WATCHED_ROOT_FILES: readonly string[] = [
	"AGENTS.md",
	"ARCHITECTURE.md",
	"CLAUDE.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"GEMINI.md",
	"Home.md",
	"LICENSE",
	"README.md",
	".gitignore",
	".mcp.json",
	"vault-manifest.json",
	"obsidian-mind-demo.gif",
	"obsidian-mind-logo.png",
];

function listTopLevelFiles(dir: string, exts: readonly string[]): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && exts.some((x) => e.name.endsWith(x)))
		.map((e) => join(dir, e.name));
}

function listRootFiles(allowlist: readonly string[]): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(".", { withFileTypes: true });
	} catch {
		return [];
	}
	const present = new Set(
		entries.filter((e) => e.isFile()).map((e) => e.name),
	);
	const out: string[] = [];
	for (const name of allowlist) {
		if (present.has(name)) out.push(name);
	}
	// Additionally include translated READMEs (README.<lang>.md). These are
	// managed as a glob in the manifest (`README.*.md`) rather than an
	// enumerated list, so discover them dynamically.
	for (const e of entries) {
		if (!e.isFile()) continue;
		if (/^README\.[^/]+\.md$/.test(e.name) && e.name !== "README.md") {
			out.push(e.name);
		}
	}
	return out;
}

function main(): void {
	const manifest = JSON.parse(
		readFileSync("vault-manifest.json", "utf-8"),
	) as Manifest;
	const globs = manifest.infrastructure ?? [];

	const missing: string[] = [];
	for (const { dir, exts } of WATCHED) {
		for (const path of listTopLevelFiles(dir, exts)) {
			if (!isCovered(path, globs)) missing.push(path);
		}
	}
	for (const path of listRootFiles(WATCHED_ROOT_FILES)) {
		if (!isCovered(path, globs)) missing.push(path);
	}

	if (missing.length === 0) return;

	console.log(
		"::warning::The following files are not covered by vault-manifest.json infrastructure globs:",
	);
	for (const f of missing) console.log(`  - ${f}`);
	console.log("");
	console.log(
		"If these are template infrastructure files, add them to the 'infrastructure' array in vault-manifest.json.",
	);
	console.log(
		"Also consider adding a version_fingerprints entry if this is a new version-defining file.",
	);
}

if (isMainModule(import.meta.url)) main();
