#!/usr/bin/env node
/**
 * Emit the auto-memory MEMORY.md index to stdout (#125), derived from
 * brain/ frontmatter. The caller owns the destination — the memory dir
 * path is session-specific (~/.claude/projects/<slug>/memory/), so the
 * agent redirects:
 *
 *   node --experimental-strip-types .claude/scripts/generate-memory-index.ts \
 *     > ~/.claude/projects/<slug>/memory/MEMORY.md
 *
 * Run from the vault root (or with CLAUDE_PROJECT_DIR set).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/main-guard.ts";
import {
	extractFrontmatterField,
	isMarkdownFilename,
} from "./lib/session-start.ts";
import { generateMemoryIndex, type BrainNote } from "./lib/memory-index.ts";

/**
 * Collect brain/ notes (name + description) for index generation. Exported
 * so the tidy-fix consumer regenerates the index from the same walk.
 * Returns null when brain/ is missing.
 */
export function collectBrainNotes(root: string): BrainNote[] | null {
	let entries: string[] = [];
	try {
		entries = readdirSync(join(root, "brain")).filter((n) =>
			isMarkdownFilename(n),
		);
	} catch {
		return null;
	}
	return entries.map((f) => {
		let description: string | null = null;
		try {
			description = extractFrontmatterField(
				readFileSync(join(root, "brain", f), "utf-8"),
				"description",
			);
		} catch {
			/* unreadable → no description */
		}
		return { name: f.replace(/\.md$/i, ""), description };
	});
}

function main(): void {
	const root = process.env["CLAUDE_PROJECT_DIR"] || process.cwd();
	const notes = collectBrainNotes(root);
	if (notes === null) {
		process.stderr.write("brain/ not found — run from the vault root.\n");
		process.exit(1);
	}
	process.stdout.write(generateMemoryIndex(notes));
}

if (isMainModule(import.meta.url)) main();
