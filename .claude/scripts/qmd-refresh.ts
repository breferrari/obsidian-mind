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

import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, readStdinJson } from "./lib/hook-io.ts";
import {
	shouldRefreshForPath,
	triggerDebouncedRefresh,
} from "./lib/qmd-refresh.ts";

const DEBOUNCE_MS = 30_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// QMD_REFRESH_SENTINEL lets tests route the debounce sentinel into a
// per-file tmp path so parallel test workers don't race on the shared
// repo sentinel. Production never sets it, so the default applies.
const SENTINEL_PATH =
	process.env["QMD_REFRESH_SENTINEL"] ??
	join(SCRIPT_DIR, ".qmd-refresh-sentinel");
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");

type HookInput = {
	readonly tool_input?: unknown;
};

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

triggerDebouncedRefresh({
	sentinelPath: SENTINEL_PATH,
	workerPath: WORKER_PATH,
	debounceMs: DEBOUNCE_MS,
	logPrefix: "qmd-refresh",
});
process.exit(0);
