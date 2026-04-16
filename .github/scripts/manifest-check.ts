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
// surface. Matches the hardcoded glob list in the bash predecessor.
const WATCHED: ReadonlyArray<{
	readonly dir: string;
	readonly exts: readonly string[];
}> = [
	{ dir: ".claude/commands", exts: [".md"] },
	{ dir: ".claude/agents", exts: [".md"] },
	{ dir: ".claude/scripts", exts: [".ts"] },
	{ dir: "templates", exts: [".md"] },
	{ dir: "bases", exts: [".base"] },
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

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
