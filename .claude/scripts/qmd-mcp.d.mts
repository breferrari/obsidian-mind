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
 * Build the (command, args, shell) tuple the spawn layer should invoke.
 */
export function buildLaunchCommand(
	entry: string | null,
	extraArgs?: readonly string[],
): {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly shell: boolean;
};
