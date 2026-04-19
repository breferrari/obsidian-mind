/**
 * Cross-platform QMD invocation helpers.
 *
 * Bare `spawnSync("qmd", ...)` fails on Windows because npm installs qmd as a
 * .cmd/.ps1 shim that Node's spawn can't resolve without routing through the
 * platform shell — and even with `shell: true` the .cmd shim itself depends
 * on /bin/sh via %_prog%, which fails on stock Windows without Git Bash.
 *
 * Rather than scatter platform-conditional `shell: process.platform === "win32"`
 * flags across every qmd call, these helpers resolve @tobilu/qmd's real JS
 * entry and let callers spawn it with the current Node binary. No shell, no
 * shim, same code path on Windows, macOS, and Linux.
 *
 * Shared with `.claude/scripts/qmd-mcp.mjs` by duplicated implementation —
 * that file is .mjs (MCP servers run as their own entry), so it can't import
 * this .ts helper at Node's `--experimental-strip-types` runtime. The two
 * copies are asserted independently: `tests/qmd.test.ts` locks this file's
 * `resolveQmdEntry` + `buildQmdCommand` shape, and `tests/qmd-mcp.test.ts`
 * locks the .mjs wrapper's equivalents. Drift between the two shows up as
 * a test failure on the CI matrix rather than a silent platform bug.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Locate @tobilu/qmd's real JS entrypoint. Returns an absolute path when
 * resolvable, null when not. A null return signals the caller to fall back
 * to invoking `qmd` directly via the platform shell (last-resort path for
 * non-npm installs).
 */
export function resolveQmdEntry(): string | null {
	try {
		return require.resolve("@tobilu/qmd/dist/cli/qmd.js");
	} catch {}

	// Fallback for global npm installs that aren't on this package's resolution
	// path — ask npm directly where global packages live. Bounded timeout so a
	// hung npm process can't block a fire-and-forget hook indefinitely.
	const npmRoot = spawnSync("npm", ["root", "-g"], {
		shell: true,
		encoding: "utf8",
		timeout: 3000,
	});
	if (npmRoot.error || npmRoot.signal !== null || npmRoot.status !== 0) {
		return null;
	}

	const root = (npmRoot.stdout ?? "").trim();
	if (root === "" || !isAbsolute(root)) return null;

	const entry = join(root, "@tobilu", "qmd", "dist", "cli", "qmd.js");
	return existsSync(entry) ? entry : null;
}

/**
 * Build the (command, args, shell) tuple for a qmd invocation. When an
 * entrypoint resolves, `process.execPath` runs it directly with no shell
 * (identical on every platform). When it doesn't, fall back to `qmd` via
 * the platform shell — best-effort for non-npm installs.
 */
export function buildQmdCommand(
	entry: string | null,
	subcommandArgs: readonly string[],
): {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly shell: boolean;
} {
	return entry !== null
		? {
				cmd: process.execPath,
				args: [entry, ...subcommandArgs],
				shell: false,
			}
		: { cmd: "qmd", args: [...subcommandArgs], shell: true };
}
