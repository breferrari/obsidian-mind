#!/usr/bin/env node
/**
 * PostToolUse hook — trigger a detached QMD refresh after the agent
 * writes or edits a vault markdown file. Closes the staleness window
 * between SessionStart's initial `qmd update` and the next session's
 * hook run, so mid-session writes become searchable without a restart.
 *
 * Design contract:
 *  - Returns in milliseconds. Never blocks the agent or user.
 *  - Never writes to stdout. Hook protocol: silent = success.
 *  - Fire-and-forget child: detached + unref + stdio: 'ignore' so the
 *    worker survives parent exit and the parent doesn't wait on it.
 *  - Debounced via `.qmd-refresh-sentinel` mtime so a burst of N writes
 *    triggers ≤ 1 worker in the debounce window (default 30s).
 *  - Graceful no-op when qmd isn't installed, the path is ineligible,
 *    or debouncing is active. Each short-circuit exits 0 silently.
 *
 * Cross-platform: path normalization + skip filtering runs on the
 * forward-slash form of the input, so `C:\\vault\\note.md` and
 * `/vault/note.md` are treated identically. The detached spawn uses
 * `windowsHide: true` to prevent a transient console window on Windows.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	dirname,
	join,
	resolve as resolvePath,
} from "node:path";
import {
	closeSync,
	futimesSync,
	openSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { debug, readStdinJson } from "./lib/hook-io.ts";
import { isDebounced, shouldRefreshForPath } from "./lib/qmd-refresh.ts";
import { resolveQmdEntry } from "./lib/qmd.ts";

const DEBOUNCE_MS = 30_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SENTINEL_PATH = join(SCRIPT_DIR, ".qmd-refresh-sentinel");
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");

type HookInput = {
	readonly tool_input?: unknown;
};

function readSentinelMtime(): number | null {
	try {
		return statSync(SENTINEL_PATH).mtimeMs;
	} catch {
		return null;
	}
}

function touchSentinel(): void {
	try {
		const now = new Date();
		try {
			const fd = openSync(SENTINEL_PATH, "a");
			try {
				futimesSync(fd, now, now);
			} finally {
				closeSync(fd);
			}
		} catch {
			// fallback: create the file (covers the first-run case on systems
			// where `open('a')` fails because the parent directory has just been
			// recreated, e.g. after a checkout)
			writeFileSync(SENTINEL_PATH, "");
		}
	} catch (err) {
		debug(
			`qmd-refresh: sentinel write failed: ${(err as Error)?.message ?? "?"}`,
		);
	}
}

function spawnWorker(): void {
	// Detached child: survives parent exit, writes no output, no console
	// window on Windows. Node re-executes itself with the strip-types flag
	// so the worker runs without a build step, matching how the rest of
	// the hook scripts are invoked from settings.json.
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", WORKER_PATH],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			cwd: process.cwd(),
		},
	);
	child.on("error", (err) => {
		debug(`qmd-refresh: worker spawn error: ${err.message}`);
	});
	child.unref();
}

const input = await readStdinJson<HookInput>();
if (!input) {
	debug("qmd-refresh: null input");
	process.exit(0);
}

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== "object") {
	debug("qmd-refresh: missing tool_input");
	process.exit(0);
}

const filePath = (toolInput as Record<string, unknown>).file_path;
if (typeof filePath !== "string") {
	debug("qmd-refresh: missing file_path");
	process.exit(0);
}

if (!shouldRefreshForPath(filePath)) {
	debug(`qmd-refresh: skipped ${filePath}`);
	process.exit(0);
}

if (isDebounced(readSentinelMtime(), Date.now(), DEBOUNCE_MS)) {
	debug(`qmd-refresh: debounced ${filePath}`);
	process.exit(0);
}

// Skip silently when qmd isn't installed. Same pattern as session-start.ts
// — no shim resolution, no spawn, no orphaned child processes.
if (resolveQmdEntry() === null) {
	debug("qmd-refresh: qmd not resolvable; skipping");
	process.exit(0);
}

touchSentinel();
spawnWorker();
debug(`qmd-refresh: triggered for ${filePath}`);
process.exit(0);
