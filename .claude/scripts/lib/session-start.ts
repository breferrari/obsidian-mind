/**
 * Pure helpers for session-start context assembly — extracted so the
 * formatting logic is unit-testable without spawning git, reading the file
 * system, or invoking the Obsidian CLI.
 */

export function take(stdout: string, n: number): string {
	return stdout.split("\n").slice(0, n).join("\n");
}

/**
 * Local-time date header matching `date +%Y-%m-%d` followed by the weekday
 * name. Separate from `new Date()` so tests can pass a fixed date.
 */
export function formatDateHeader(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
	return `${y}-${m}-${day} (${weekday})`;
}

/**
 * Format the "Active Work" section from a list of filenames in work/active.
 * Strips `.md`, keeps the first `limit`, returns "(none)" for empty input.
 */
export function formatActiveWork(
	filenames: readonly string[],
	limit: number,
): string {
	const names = filenames
		.filter((f) => f.endsWith(".md"))
		.map((f) => f.replace(/\.md$/, ""))
		.slice(0, limit);
	return names.length > 0 ? names.join("\n") : "(none)";
}

/**
 * Format the "Recent Changes" section from raw `git log --oneline` output.
 * Strips blank lines, keeps the first `limit`, falls back to
 * "(no git history)" when empty (matching the legacy shell message).
 */
export function formatRecentChanges(gitOutput: string, limit: number): string {
	const lines = gitOutput
		.split("\n")
		.filter((l) => l.length > 0)
		.slice(0, limit);
	return lines.length > 0 ? lines.join("\n") : "(no git history)";
}

/**
 * Return true if a path (relative, using "/" separators) falls under any
 * of the supplied skip prefixes. A prefix like ".git" matches ".git" and
 * ".git/anything" but not ".github" (exact segment boundary).
 */
export function isSkippedPath(
	pathRel: string,
	skipPrefixes: readonly string[],
): boolean {
	return skipPrefixes.some(
		(p) => pathRel === p || pathRel.startsWith(p + "/"),
	);
}

/**
 * Escape regex metacharacters in a string so it can be embedded safely
 * inside a `new RegExp(...)` pattern as a literal.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the closing `---` delimiter of a YAML frontmatter block. The input
 * is assumed to start with `---` (caller checks). Returns the index of the
 * newline before the closing delimiter, or -1 if the block is unterminated.
 *
 * Matches only a full delimiter line (`\n---\n`, `\n---\r\n`, or `\n---` at
 * EOF) so body content like `---foo` after a newline is not treated as the
 * terminator.
 */
function findFrontmatterEnd(content: string): number {
	const m = content.slice(3).match(/\n---(?:\r?\n|$)/);
	return m && m.index !== undefined ? m.index + 3 : -1;
}

/**
 * Extract a string value for `field` from YAML frontmatter at the top of
 * a markdown document. Supports quoted ("..."), single-quoted ('...'),
 * and bare values on the same line as the key. Returns null when the
 * frontmatter block or field is absent.
 *
 * This is a deliberately small parser — just enough for one-line string
 * fields like `description:`. Multi-line/block YAML is out of scope.
 * Handles CRLF line endings and escapes regex metacharacters in `field`.
 */
export function extractFrontmatterField(
	content: string,
	field: string,
): string | null {
	if (!content.startsWith("---")) return null;
	const end = findFrontmatterEnd(content);
	if (end === -1) return null;
	const fm = content.slice(3, end);
	const re = new RegExp(
		`^${escapeRegex(field)}:[ \\t]*(.*?)[ \\t]*\\r?$`,
		"m",
	);
	const m = fm.match(re);
	if (!m) return null;
	const raw = m[1] ?? "";
	if (raw === "") return null;
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1);
	}
	return raw;
}

/**
 * Return the body of a markdown document with its leading YAML frontmatter
 * stripped. If there's no frontmatter block, returns the input unchanged.
 * Handles both LF and CRLF delimiters.
 */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = findFrontmatterEnd(content);
	if (end === -1) return content;
	const rest = content.slice(end);
	const m = rest.match(/^\n---(\r?\n|$)/);
	return m ? rest.slice(m[0].length) : rest;
}

/**
 * True if the body contains at least one list item with text content —
 * i.e. a bullet like `- foo`, not a bare `-` placeholder. Brain topic
 * notes are list-shaped by template, so this is the clearest signal of
 * "has the user actually added anything here yet?"
 */
export function hasBrainContent(body: string): boolean {
	return /^[ \t]*[-*+][ \t]+\S.*$/m.test(body);
}

/**
 * Format the "Brain Topics" section — one line per brain/ note with its
 * description from frontmatter, so Claude sees what topic notes exist
 * without loading their full content. Omits North Star (already loaded
 * in its own section) and Memories (an index that just points here).
 * Appends "(empty)" when the note has no filled bullets, so Claude
 * knows not to waste a read on a stub.
 */
export function formatBrainIndex(
	entries: readonly {
		readonly name: string;
		readonly description: string | null;
		readonly hasContent: boolean;
	}[],
): string {
	const lines = entries
		.filter((e) => e.name !== "North Star" && e.name !== "Memories")
		.map((e) => {
			const desc = e.description ?? "(no description)";
			const suffix = e.hasContent ? "" : " (empty)";
			return `- [[${e.name}]] — ${desc}${suffix}`;
		});
	return lines.length > 0 ? lines.join("\n") : "(none)";
}
