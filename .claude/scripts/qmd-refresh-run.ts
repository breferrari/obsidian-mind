#!/usr/bin/env node
/**
 * Detached worker for the mid-session QMD refresh. Invoked by
 * `qmd-refresh.ts` (PostToolUse hook) and `stop-checklist.ts` (Stop
 * hook) as a backgrounded child so the hook itself returns in
 * milliseconds.
 *
 * Runs `qmd update` (BM25/FTS) followed by `qmd embed` (vector index)
 * so mid-session writes become searchable through every retrieval arm,
 * not just keyword search. Each step's timeout travels on the
 * invocation tuple from `composeWorkerInvocations`, so reordering the
 * pipeline can never silently swap timeouts onto the wrong step.
 *
 * Never writes to stdout/stderr. Never exits non-zero in a way the
 * user sees, since both parents `stdio: 'ignore'` the child. qmd
 * failures are swallowed deliberately: QMD is optional infrastructure,
 * and a flaky refresh must not pollute the next session's context or
 * terminal.
 *
 * Cwd independence: the vault root is derived from the worker's own
 * absolute script path (`<vault>/.claude/scripts/`), not from
 * `process.cwd()` or env vars. This survives the case where the parent
 * hook fires from a drifted shell cwd without CLAUDE_PROJECT_DIR set —
 * without that anchor, the manifest read failed silently and the
 * worker updated QMD's default global collection instead of the
 * vault's named one.
 *
 * Multi-platform: delegates the spawn shape to `lib/qmd.ts`, which
 * routes through `process.execPath qmd.js` on every OS, bypassing the
 * .cmd shim on Windows.
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

for (const inv of invocations) {
	const result = spawnSync(inv.cmd, inv.args as string[], {
		stdio: "ignore",
		timeout: inv.timeoutMs,
		shell: inv.shell,
		windowsHide: true,
		cwd: VAULT_ROOT,
	});
	if (result.error) {
		debug(`qmd-refresh-run: ${inv.args.join(" ")} — ${result.error.message}`);
	}
}
