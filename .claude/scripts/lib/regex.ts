/**
 * Small regex utilities used across scripts and hooks.
 */

/**
 * Escape regex metacharacters in a string so it can be embedded safely
 * inside a `new RegExp(...)` pattern as a literal.
 */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
