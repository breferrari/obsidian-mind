/**
 * Type declarations for qmd-mcp.mjs so TypeScript tests can import it.
 * The runtime file is plain ESM JS (.mjs) to avoid a build step; this file
 * mirrors its public exports for `tsc --noEmit`.
 */

/**
 * Locate @tobilu/qmd's real JS entrypoint. Returns an absolute path when
 * resolvable, null when not.
 */
export function resolveQmdEntry(): string | null;

/**
 * Resolve the vault root directory from a `file://` URL and optional env.
 * The env argument is read for `CLAUDE_PROJECT_DIR` (Claude Code's
 * project-dir signal); when absent, the root is computed from the URL.
 */
export function resolveVaultRoot(
	metaUrl: string,
	env?: NodeJS.ProcessEnv,
): string;

/**
 * Extract the `qmd_index` string from a vault-manifest.json source.
 * Returns the named index or null when absent, malformed, or empty.
 */
export function readQmdIndex(manifestJson: string | null): string | null;

/**
 * Derive an index name from the vault folder, slugified. Returns null when
 * the folder name yields nothing usable. Mirrors
 * `lib/session-start.ts:deriveQmdIndex`; the tests assert the two agree.
 */
export function deriveQmdIndex(vaultRoot: string): string | null;

/**
 * The index this vault owns: an explicit `qmd_index` pin wins, else the
 * folder-derived slug. Null means "use QMD's default global index".
 */
export function resolveQmdIndex(
	manifestJson: string | null,
	vaultRoot: string,
): string | null;

/**
 * Compute the SQLite store path qmd would use for a given named index,
 * using the same rule as @tobilu/qmd's store.js.
 */
export function resolveIndexSqlitePath(
	indexName: string,
	env: NodeJS.ProcessEnv,
	home: string,
): string;

/**
 * Build the (command, args, shell) tuple the spawn layer should invoke.
 * When `qmdIndex` is a non-empty string, `--index <name>` is prepended to
 * the mcp subcommand.
 */
export function buildLaunchCommand(
	entry: string | null,
	extraArgs?: readonly string[],
	qmdIndex?: string | null,
): {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly shell: boolean;
};
