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
