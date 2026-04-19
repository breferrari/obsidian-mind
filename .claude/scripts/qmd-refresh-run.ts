#!/usr/bin/env node
/**
 * Detached worker for the mid-session QMD refresh. Invoked by
 * `qmd-refresh.ts` (PostToolUse hook) and `stop-checklist.ts` (Stop hook)
 * as a backgrounded child so the hook itself returns in milliseconds.
 *
 * Runs `qmd update` (BM25/FTS) followed by `qmd embed` (vector index) so
 * mid-session writes become searchable through every retrieval arm, not
 * just keyword search. Each call is bounded by a generous timeout — we're
 * already detached, so the goal is bounded drag on machine resources, not
 * user-facing latency.
 *
 * Never writes to stdout/stderr. Never exits non-zero in a way the user
 * sees, since both parents `stdio: 'ignore'` the child. qmd failures are
 * swallowed deliberately: QMD is optional infrastructure, and a flaky
 * refresh must not pollute the next session's context or terminal.
 *
 * Cwd independence: the vault root is derived from the worker's own
 * absolute script path (`<vault>/.claude/scripts/qmd-refresh-run.ts`),
 * not from `process.cwd()` or env vars. This survives the case where the
 * parent hook fires from a drifted shell cwd without CLAUDE_PROJECT_DIR
 * set — without it, the manifest read failed silently and the worker
 * updated QMD's default global collection instead of the vault's named
 * one. Anchoring to script-relative paths eliminates that class of bug.
 *
 * Multi-platform: delegates the spawn shape to `lib/qmd.ts`, which routes
 * through `process.execPath qmd.js` on every OS, bypassing the .cmd shim
 * on Windows.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { debug } from "./lib/hook-io.ts";
import { parseQmdIndex, qmdArgsWithIndex } from "./lib/session-start.ts";
import { buildQmdCommand, resolveQmdEntry } from "./lib/qmd.ts";

// Resolve the vault root from the worker's own location rather than cwd
// or env vars. The script lives at <vault>/.claude/scripts/, so the vault
// root is always two directories up.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = resolvePath(SCRIPT_DIR, "..", "..");
const MANIFEST_PATH = resolvePath(VAULT_ROOT, "vault-manifest.json");

function readManifestRaw(): string | null {
	try {
		return readFileSync(MANIFEST_PATH, { encoding: "utf-8" });
	} catch {
		return null;
	}
}

function runQmd(
	subcommand: readonly string[],
	qmdIndex: string | null,
	entry: string | null,
	timeoutMs: number,
): void {
	const built = buildQmdCommand(entry, qmdArgsWithIndex(qmdIndex, subcommand));
	const result = spawnSync(built.cmd, built.args as string[], {
		stdio: "ignore",
		timeout: timeoutMs,
		shell: built.shell,
		windowsHide: true,
		cwd: VAULT_ROOT,
	});
	if (result.error) {
		debug(
			`qmd-refresh-run: ${subcommand.join(" ")} error: ${result.error.message}`,
		);
	}
}

const qmdIndex = parseQmdIndex(readManifestRaw());
const entry = resolveQmdEntry();

// 60s is enough for an incremental update on a 10k-note vault; bootstrap
// on a fresh machine is the only time this would plausibly overflow, and
// bootstrap is not our caller.
runQmd(["update"], qmdIndex, entry, 60_000);

// 5min for embed — first-time runs on fresh hardware can download the
// embedding model. After the model is cached locally, incremental embeds
// of a handful of new chunks take ~1-2s on an M1 Max and proportionally
// longer on CPU-only machines. This cap is generous by design; the
// parent hook has already exited so the user doesn't wait on us.
runQmd(["embed"], qmdIndex, entry, 300_000);
