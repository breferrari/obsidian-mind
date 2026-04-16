/**
 * Validation logic for the validate-write hook: path skip rules, required
 * frontmatter fields, and wikilink presence on non-trivial notes.
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";

const ROOT_FILES: ReadonlySet<string> = new Set([
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"CLAUDE.md",
	"AGENTS.md",
	"GEMINI.md",
]);

const SKIP_PATH_SEGMENTS: readonly string[] = [
	".claude/",
	".codex/",
	".gemini/",
	".github/",
	".obsidian/",
	"templates/",
	"thinking/",
];

/**
 * Return true if the file should be skipped (not validated).
 * Skips non-markdown, dotfiles, templates, root docs, and translated READMEs.
 */
export function shouldSkipFile(filePath: string): boolean {
	if (!filePath || !filePath.endsWith(".md")) return true;

	const normalized = filePath.replaceAll("\\", "/");
	const base = basename(normalized);

	if (ROOT_FILES.has(base)) return true;

	if (base.startsWith("README.") && base.endsWith(".md")) return true;

	for (const segment of SKIP_PATH_SEGMENTS) {
		if (normalized.includes(segment)) return true;
	}

	return false;
}

/**
 * Inspect markdown content and return a list of warnings. Empty list means
 * the note is valid by our conventions.
 */
export function validateContent(content: string): string[] {
	const warnings: string[] = [];

	if (!content.startsWith("---")) {
		warnings.push("Missing YAML frontmatter");
	} else {
		const parts = content.split("---");
		if (parts.length >= 3) {
			const fm = parts[1] ?? "";
			if (!fm.includes("tags:") && !fm.includes("tags :")) {
				warnings.push("Missing `tags` in frontmatter");
			}
			if (!fm.includes("description:") && !fm.includes("description :")) {
				warnings.push(
					"Missing `description` in frontmatter (~150 chars required by vault convention)",
				);
			}
			if (!fm.includes("date:") && !fm.includes("date :")) {
				warnings.push("Missing `date` in frontmatter");
			}
		}
	}

	if (content.length > 300 && !content.includes("[[")) {
		warnings.push(
			"No [[wikilinks]] found — every note must link to at least one other note (vault convention)",
		);
	}

	return warnings;
}

/**
 * Read a file from disk and validate it. Returns null on read error
 * (caller should treat null as "skip silently" per hook protocol).
 */
export function validateFile(filePath: string): string[] | null {
	try {
		const content = readFileSync(filePath, { encoding: "utf-8" });
		return validateContent(content);
	} catch {
		return null;
	}
}
