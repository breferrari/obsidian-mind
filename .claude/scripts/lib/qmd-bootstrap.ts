/**
 * Pure helpers extracted from `scripts/qmd-bootstrap.ts` so they can be
 * exercised by unit tests without spawning qmd.
 *
 * QMD's `collection add` reads the collection name only from `--name` and the
 * glob only from `--mask`. The CLI uses `util.parseArgs` with `strict: false`,
 * so a positional name and a `--pattern` flag are both silently dropped. We
 * also avoid QMD's path-based auto-derivation (split on '/' only), which
 * misbehaves on native Windows backslash paths — see issue #85.
 */

import { escapeRegex } from "./regex.ts";

const DEFAULT_GLOB = "**/*.md";

/**
 * Build the argv passed to `qmd collection add` for an obsidian-mind vault.
 *
 * Shape: `--index <index> collection add . --name <name> --mask <glob>`.
 *
 *   - The positional `.` is read by QMD as the working directory (cli.args[1]).
 *     A value placed there cannot be repurposed as the collection name.
 *   - `--name <name>` is the only way to set the collection name without
 *     relying on QMD's auto-derivation, which splits the pwd on '/' only
 *     and falls back to `process.cwd()` on platforms where `$PWD` is unset
 *     (stock Windows PowerShell / CMD).
 *   - `--mask <glob>` is the real glob flag; QMD silently ignores `--pattern`.
 */
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
 * Predicate for the bootstrap's `runIdempotent` helper. Returns true when
 * QMD's output reports that the collection we asked for already exists
 * **by name** — the benign case on a re-run of the bootstrap.
 *
 * Crucially this does NOT match QMD's other "A collection already exists for
 * this path and pattern:" warning, which signals a stale-name collision (an
 * upgrader who has an old wrongly-named collection pointing at the same vault
 * path after the issue #85 fix). That case must surface so the user follows
 * QMD's own `qmd collection remove ...` instruction, not be silently swallowed.
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
