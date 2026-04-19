#!/usr/bin/env node
/**
 * qmd-mcp.mjs — cross-platform MCP launcher for QMD.
 *
 * Claude Code spawns MCP servers without a shell, so on Windows the npm-installed
 * `qmd` shim (a .cmd/.ps1 file) can't be located from `child_process.spawn`. Even
 * with shell: true, the shim itself delegates to /bin/sh via %_prog%, which fails
 * on stock Windows without Git Bash's sh.exe on PATH.
 *
 * This wrapper bypasses the shim by resolving @tobilu/qmd's real JS entrypoint
 * and spawning it with the current Node binary. Works identically on Windows,
 * macOS, and Linux — no shell, no /bin/sh dependency.
 *
 * Fallback: if @tobilu/qmd isn't resolvable from this location (e.g., the user
 * has qmd installed via a non-npm channel), fall through to the `qmd` command
 * with shell: true so the global shim is still attempted.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Locate @tobilu/qmd's real JS entrypoint. Returns an absolute path when
 * resolvable, null when not. Exported so the cross-platform test matrix can
 * verify resolution works on Windows, macOS, and Linux without having to
 * spawn the wrapper itself.
 */
export function resolveQmdEntry() {
	try {
		return require.resolve("@tobilu/qmd/dist/cli/qmd.js");
	} catch {}

	// Fallback for global npm installs that aren't on this package's resolution
	// path — ask npm directly where global packages live. Bounded timeout so a
	// hung npm process can't block MCP server startup indefinitely.
	const npmRoot = spawnSync("npm", ["root", "-g"], {
		shell: true,
		encoding: "utf8",
		timeout: 3000,
	});
	if (
		npmRoot.error ||
		npmRoot.signal !== null ||
		npmRoot.status !== 0
	) {
		return null;
	}

	// Guard against success-with-empty-stdout or a relative path — either would
	// make join() produce a path anchored at cwd, and existsSync could then
	// match a local folder by accident.
	const root = npmRoot.stdout.trim();
	if (root === "" || !isAbsolute(root)) {
		return null;
	}

	const entry = join(root, "@tobilu", "qmd", "dist", "cli", "qmd.js");
	return existsSync(entry) ? entry : null;
}

/**
 * Build the (command, args) tuple the spawn layer should invoke. Split out
 * so tests can lock both branches (resolved entrypoint vs. PATH fallback)
 * without running a real child.
 */
export function buildLaunchCommand(entry, extraArgs = []) {
	const qmdArgs = ["mcp", ...extraArgs];
	return entry
		? { cmd: process.execPath, args: [entry, ...qmdArgs], shell: false }
		: { cmd: "qmd", args: qmdArgs, shell: true };
}

function runAsMcp() {
	const entry = resolveQmdEntry();
	const { cmd, args, shell } = buildLaunchCommand(
		entry,
		process.argv.slice(2),
	);

	const child = spawn(cmd, args, { stdio: "inherit", shell });

	// spawn() emits 'error' when the command can't be invoked at all (e.g., qmd
	// not on PATH in the fallback branch). Without a handler Node would crash
	// with a stack trace — write a concise message and exit cleanly instead.
	child.on("error", (err) => {
		process.stderr.write(
			`qmd-mcp: failed to start qmd: ${err.message}\n`,
		);
		process.exit(1);
	});

	child.on("exit", (code, signal) => {
		if (signal !== null) {
			// Re-raise the signal against ourselves so the parent sees the same
			// termination cause. Some POSIX signals (SIGKILL, SIGSTOP) or names
			// unknown on this platform will cause process.kill to throw — in
			// that case fall back to a conventional non-zero exit.
			try {
				process.kill(process.pid, signal);
			} catch {
				process.exit(1);
			}
			return;
		}
		process.exit(code ?? 0);
	});
}

// Only spawn a child when this file is the actual entry point. Importing it
// from tests (to exercise resolveQmdEntry / buildLaunchCommand in isolation)
// must not trigger a spawn.
const entryUrl = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: null;
if (entryUrl === import.meta.url) {
	runAsMcp();
}
