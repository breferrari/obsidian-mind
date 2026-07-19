/**
 * Validation logic for the validate-write hook: path skip rules, required
 * frontmatter fields, and wikilink presence on non-trivial notes.
 */

import { basename, posix } from "node:path";
import { readFileSync } from "node:fs";

const ROOT_FILES: ReadonlySet<string> = new Set([
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"ARCHITECTURE.md",
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
 * Return true if the path is an auto-memory file in ~/.claude/ that should
 * be flagged (#81). Only MEMORY.md (the auto-loaded index) is allowed there
 * — all durable knowledge goes to brain/ topic notes per CLAUDE.md.
 *
 * The path is lexically normalized first (separators unified, `.`/`..`
 * segments collapsed) so a path can't dodge the check by spelling the
 * memory dir indirectly. Callers should additionally pass a
 * realpath-resolved path when the file exists, so symlinked spellings are
 * caught too — see the guard in validate-write.ts.
 *
 * The predicate requires BOTH `/.claude/` and `/memory/` segments and
 * exempts `MEMORY.md` by basename, so it never fires on vault paths like
 * `brain/Memories.md`, project paths containing the word "memory", or
 * other `.claude/projects/<x>/` subdirs (transcripts, hook output).
 */
export function isBlockedMemoryPath(filePath: string): boolean {
	// Separators unified FIRST, then posix-normalize: normalize() on a POSIX
	// host doesn't treat "\" as a separator, so backslash-spelled ".."
	// segments would otherwise survive uncollapsed.
	const normalized = posix.normalize(filePath.replaceAll("\\", "/"));
	if (!normalized.includes("/memory/")) return false;
	if (!normalized.includes("/.claude/")) return false;
	const base = basename(normalized);
	return base !== "MEMORY.md";
}

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

	// Ticket IDs are not notes — [[PROJ-12345]] creates a phantom graph edge
	// that a broken-link gate then trips on (#108). Matches the bare form and
	// the table-escaped-pipe forms. Plain text or a tracker URL, never a
	// wikilink.
	const ticketLinks = content.match(/\[\[[A-Z]{2,10}-\d+(\\\||&#124;|\||\]\])/g);
	if (ticketLinks && ticketLinks.length > 0) {
		warnings.push(
			`${ticketLinks.length} ticket-ID wikilink(s) (e.g. [[PROJ-…]]) — ticket IDs are plain text or tracker links, never wikilinks (they are not notes)`,
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
