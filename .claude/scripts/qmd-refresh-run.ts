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
import { parseQmdIndex } from "./lib/session-start.ts";
import { resolveQmdEntry } from "./lib/qmd.ts";
import {
	composeWorkerInvocations,
	resolveVaultRoot,
} from "./lib/qmd-refresh.ts";

// 60s is enough for an incremental `update` on a 10k-note vault. First-
// time `embed` can download the embedding model on fresh machines, so
// the embed slot gets a 5-minute cap. Both are already detached, so
// these budgets bound machine drag rather than user-facing latency.
const UPDATE_TIMEOUT_MS = 60_000;
const EMBED_TIMEOUT_MS = 300_000;
const STEP_TIMEOUTS = [UPDATE_TIMEOUT_MS, EMBED_TIMEOUT_MS] as const;

// Resolve the vault root from the worker's own location rather than cwd
// or env vars. Hook scripts live at <vault>/.claude/scripts/, so
// resolveVaultRoot reliably returns the vault root even when the parent
// fires from a drifted shell cwd with no CLAUDE_PROJECT_DIR set.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = resolveVaultRoot(SCRIPT_DIR);
const MANIFEST_PATH = resolvePath(VAULT_ROOT, "vault-manifest.json");

function readManifestRaw(): string | null {
	try {
		return readFileSync(MANIFEST_PATH, { encoding: "utf-8" });
	} catch {
		return null;
	}
}

const qmdIndex = parseQmdIndex(readManifestRaw());
const invocations = composeWorkerInvocations(qmdIndex, resolveQmdEntry());

invocations.forEach((inv, i) => {
	const result = spawnSync(inv.cmd, inv.args as string[], {
		stdio: "ignore",
		timeout: STEP_TIMEOUTS[i],
		shell: inv.shell,
		windowsHide: true,
		cwd: VAULT_ROOT,
	});
	if (result.error) {
		debug(`qmd-refresh-run: step ${i} error: ${result.error.message}`);
	}
});
