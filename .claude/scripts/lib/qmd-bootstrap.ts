/**
 * Pure helpers for `scripts/qmd-bootstrap.ts`, factored out for unit-testing
 * without spawning qmd.
 *
 * Two qmd-2.x quirks drive the shape here. Its CLI runs `util.parseArgs` with
 * `strict: false`, so a positional name and a `--pattern` flag are both
 * silently dropped — name comes from `--name`, glob from `--mask`. And when
 * `--name` is absent, qmd auto-derives the name from `pwd.split('/').pop()`,
 * which mis-fires on native Windows backslash paths.
 */

import { escapeRegex } from "./regex.ts";

const DEFAULT_GLOB = "**/*.md";

export function buildCollectionAddArgs(
	index: string,
	collectionName: string,
	glob: string = DEFAULT_GLOB,
): readonly string[] {
	return [
		"--index",
		index,
		"collection",
		"add",
		".",
		"--name",
		collectionName,
		"--mask",
		glob,
	];
}

/**
 * Matches qmd's by-name "already exists" output (benign on bootstrap re-run).
 * Does NOT match qmd's "A collection already exists for this path and pattern"
 * warning — that signals a stale-name collision and must surface so the user
 * runs the `qmd collection remove ...` qmd itself suggests.
 */
export function makeCollectionAddBenignMatcher(
	expectedName: string,
): (o: { readonly stdout: string; readonly stderr: string }) => boolean {
	const re = new RegExp(
		`Collection ['"]?${escapeRegex(expectedName)}['"]? already exists`,
		"i",
	);
	return (o) => re.test(o.stderr) || re.test(o.stdout);
}

/**
 * Matches qmd's "No context found for:" output — emitted on both the
 * virtual-path (qmd.js:630) and filesystem-path (qmd.js:656) branches of
 * `contextRemove` when the context row doesn't exist. Benign on first-run.
 *
 * Narrow on purpose: a plain `not found` substring would also match qmd's
 * `Collection not found: <name>` (qmd.js:625), which signals our collection
 * isn't registered at all — a real error that must surface.
 */
export function isContextRemoveBenign(o: {
	readonly stdout: string;
	readonly stderr: string;
}): boolean {
	return (
		/no context found for/i.test(o.stderr) ||
		/no context found for/i.test(o.stdout)
	);
}
