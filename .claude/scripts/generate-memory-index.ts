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

function main(): void {
	const root = process.env["CLAUDE_PROJECT_DIR"] || process.cwd();
	let entries: string[] = [];
	try {
		entries = readdirSync(join(root, "brain")).filter((n) =>
			isMarkdownFilename(n),
		);
	} catch {
		process.stderr.write("brain/ not found — run from the vault root.\n");
		process.exit(1);
	}
	const notes: BrainNote[] = entries.map((f) => {
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
	process.stdout.write(generateMemoryIndex(notes));
}

if (isMainModule(import.meta.url)) main();
