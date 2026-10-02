/**
 * The project directory the calling agent gave a hook or script.
 *
 * Each agent names the project directory in its own variable: Claude Code
 * sets CLAUDE_PROJECT_DIR; the Codex and Gemini configs pass
 * CODEX_PROJECT_DIR and GEMINI_PROJECT_DIR. The first non-empty one wins.
 * An empty value counts as unset (`||`, not `??`): an empty string is never
 * a usable root, and treating it as one resolved paths against "".
 *
 * The fallback is the caller's. Every hook passes the working directory:
 * the hook commands themselves resolve their script through
 * `${*_PROJECT_DIR:-.}`, so when the variable is unset the hook only runs at
 * all if cwd is the vault. Not to be confused with qmd-refresh.ts's
 * resolveVaultRoot, which ignores these variables on purpose (a detached
 * worker anchors to its own location), or with mcp-context.ts's, which
 * reads OM_VAULT_PATH for the MCP server.
 */

const PROJECT_DIR_VARS = [
	"CLAUDE_PROJECT_DIR",
	"CODEX_PROJECT_DIR",
	"GEMINI_PROJECT_DIR",
] as const;

export function resolveProjectDir(
	fallback: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	for (const name of PROJECT_DIR_VARS) {
		const value = env[name];
		if (value) return value;
	}
	return fallback;
}
