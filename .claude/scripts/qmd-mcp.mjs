#!/usr/bin/env node
/**
 * qmd-mcp.mjs — cross-platform MCP launcher for QMD.
 *
 * Does three things no bare `qmd mcp` invocation can do:
 *
 *   1. Bypass the Windows .cmd/.ps1 shim. Claude Code spawns MCP servers
 *      without a shell, and even `shell: true` isn't enough: the shim
 *      delegates to /bin/sh via %_prog%, which fails on stock Windows without
 *      Git Bash's sh.exe on PATH. We resolve @tobilu/qmd/dist/cli/qmd.js and
 *      spawn it with the current Node binary — no shell, no shim, same code
 *      path on every platform.
 *
 *   2. Scope the MCP server to this vault's named index. If vault-manifest.json
 *      declares a `qmd_index`, pass `--index <name>` so the MCP reads the same
 *      SQLite store as the SessionStart hook and the CLI.
 *
 *   3. Work around a qmd 2.1.0 bug. `qmd --index <name> mcp` currently ignores
 *      the --index flag (mcp/server.js calls getDefaultDbPath() without the
 *      configured name). Setting INDEX_PATH forces the correct SQLite path
 *      regardless — store.js honors INDEX_PATH unconditionally. We keep
 *      --index on argv too so a future qmd fix works without a wrapper change.
 *
 * Fallback: if @tobilu/qmd isn't resolvable, fall through to a bare `qmd`
 * command with shell: true so non-npm installations still have a chance to
 * work. When an index is configured, the INDEX_PATH env var still applies.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

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
 * Restricted character set for `qmd_index`. Duplicated from
 * `lib/session-start.ts:QMD_INDEX_PATTERN` (this file is .mjs and can't
 * import from the .ts lib at strip-types runtime). The shape is asserted
 * by the tests — alnum + dot + dash + underscore, must start with alnum.
 * Rejects path separators, parent-dir refs, whitespace, empty strings.
 */
const QMD_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Extract the `qmd_index` string from a vault-manifest.json source. Returns
 * the configured named index (so QMD's storage is scoped to this vault) or
 * null when the manifest is absent, malformed, missing the field, or the
 * value fails validation.
 *
 * Kept as a pure helper so tests can pass fixture strings. A null return
 * means "use QMD's default global index" — backwards-compatible with forks
 * that haven't adopted the field yet.
 */
export function readQmdIndex(manifestJson) {
	if (manifestJson === null) return null;
	try {
		const parsed = JSON.parse(manifestJson);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof parsed.qmd_index === "string" &&
			QMD_INDEX_PATTERN.test(parsed.qmd_index)
		) {
			return parsed.qmd_index;
		}
	} catch {
		/* malformed manifest → treat as missing */
	}
	return null;
}

/**
 * Compute the SQLite store path qmd would use for a given named index, using
 * the same rule as @tobilu/qmd's store.js (XDG_CACHE_HOME || ~/.cache +
 * qmd/<indexName>.sqlite). Exported so tests can lock the platform-neutral
 * behavior — qmd uses this same logic on Linux, macOS, and Windows with no
 * per-platform branch.
 */
export function resolveIndexSqlitePath(indexName, env, home) {
	const base = env["XDG_CACHE_HOME"] ?? join(home, ".cache");
	return join(base, "qmd", `${indexName}.sqlite`);
}

/**
 * Build the (command, args, shell) tuple the spawn layer should invoke.
 * When `qmdIndex` is a non-empty string, `--index <name>` is prepended to
 * the mcp subcommand; otherwise the invocation matches the pre-per-vault
 * shape for backward compatibility.
 */
export function buildLaunchCommand(entry, extraArgs = [], qmdIndex = null) {
	const mcpArgs = qmdIndex ? ["--index", qmdIndex, "mcp"] : ["mcp"];
	const qmdArgs = [...mcpArgs, ...extraArgs];
	return entry
		? { cmd: process.execPath, args: [entry, ...qmdArgs], shell: false }
		: { cmd: "qmd", args: qmdArgs, shell: true };
}

function readManifestRaw() {
	try {
		return readFileSync("vault-manifest.json", { encoding: "utf-8" });
	} catch {
		return null;
	}
}

function runAsMcp() {
	const qmdIndex = readQmdIndex(readManifestRaw());

	if (qmdIndex && !process.env["INDEX_PATH"]) {
		// Apply the qmd 2.1.0 MCP bug workaround: pin the SQLite store to the
		// named index. Don't clobber a user-supplied INDEX_PATH.
		process.env["INDEX_PATH"] = resolveIndexSqlitePath(
			qmdIndex,
			process.env,
			homedir(),
		);
	}

	const entry = resolveQmdEntry();
	const { cmd, args, shell } = buildLaunchCommand(
		entry,
		process.argv.slice(2),
		qmdIndex,
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
// from tests (to exercise the pure helpers in isolation) must not trigger a
// spawn.
const entryUrl = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: null;
if (entryUrl === import.meta.url) {
	runAsMcp();
}
