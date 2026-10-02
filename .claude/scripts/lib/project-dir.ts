/**
 * The project directory the calling agent gave a hook or script.
 *
 * Each agent names the project directory in its own variable: Claude Code
 * sets CLAUDE_PROJECT_DIR; the Codex and Gemini configs pass
 * CODEX_PROJECT_DIR and GEMINI_PROJECT_DIR. The first non-empty one wins.
 * An empty value counts as unset (`||`, not `??`): an empty string is never
 * a usable root, and treating it as one resolved paths against "".
 *
 * The fallback is the caller's. Every hook passes the working directory.
 * The Codex and Gemini hook commands resolve their script through
 * `${*_PROJECT_DIR:-.}`, so there a hook only runs at all when the variable
 * or cwd names the vault root. The Claude commands walk up from
 * `${CLAUDE_PROJECT_DIR:-.}` instead (below). Not to be confused with qmd-refresh.ts's
 * resolveVaultRoot, which ignores these variables on purpose (a detached
 * worker anchors to its own location), or with mcp-context.ts's, which
 * reads the MCP server's own vault-path override.
 *
 * The directory named is not always the vault root (#263). Claude Code sets
 * CLAUDE_PROJECT_DIR to the folder the session was launched in and does not
 * update it on `/cd`, so a session started in a vault subfolder and moved to
 * the root with `/cd` loads the root's hooks while the variable still names
 * the subfolder. So the result walks up from the named directory to the
 * nearest one holding `vault-manifest.json`, and falls back to the named
 * directory itself when there is none above it (a script run outside a
 * vault keeps today's behaviour). The Claude hook commands do the same walk
 * in the shell, to find the script at all.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const PROJECT_DIR_VARS = [
	"CLAUDE_PROJECT_DIR",
	"CODEX_PROJECT_DIR",
	"GEMINI_PROJECT_DIR",
] as const;

/** The file whose presence marks a vault root. */
export const VAULT_MARKER = "vault-manifest.json";

const holdsMarker = (dir: string): boolean => existsSync(join(dir, VAULT_MARKER));

export function resolveProjectDir(
	fallback: string,
	env: NodeJS.ProcessEnv = process.env,
	isVaultRoot: (dir: string) => boolean = holdsMarker,
): string {
	let named = fallback;
	for (const name of PROJECT_DIR_VARS) {
		const value = env[name];
		if (value) {
			named = value;
			break;
		}
	}
	return nearestVaultRoot(named, isVaultRoot) ?? named;
}

/** `dir` or the nearest ancestor that is a vault root, or null when none is. */
export function nearestVaultRoot(
	dir: string,
	isVaultRoot: (dir: string) => boolean = holdsMarker,
): string | null {
	for (let current = dir; ; current = dirname(current)) {
		if (isVaultRoot(current)) return current;
		if (dirname(current) === current) return null;
	}
}
