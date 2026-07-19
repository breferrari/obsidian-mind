#!/usr/bin/env node
/**
 * Stop hook — remind the user of session-wrap-up tasks and kick a
 * debounced QMD refresh so the next session opens against a current
 * index.
 *
 * Silently exits when the hook is being re-entered by a secondary
 * agent (stop_hook_active=true) to avoid recursive reminder output and
 * duplicated refresh spawns. Otherwise prints the vault-hygiene
 * checklist and routes through the same `triggerDebouncedRefresh`
 * entry the PostToolUse hook uses — one debounce contract, one spawn
 * shape, zero drift between the two paths.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson } from "./lib/hook-io.ts";
import { triggerDebouncedRefresh } from "./lib/qmd-refresh.ts";
import {
	formatActiveHygiene,
	parseOpenLoopConfig,
	scanActiveHygiene,
} from "./lib/active-hygiene.ts";
import { parseInfraRootFilenames } from "./lib/session-start.ts";

const DEBOUNCE_MS = 30_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// See qmd-refresh.ts for the rationale behind the env override — it
// keeps parallel test workers from racing on the shared repo sentinel.
const SENTINEL_PATH =
	process.env["QMD_REFRESH_SENTINEL"] ??
	join(SCRIPT_DIR, ".qmd-refresh-sentinel");
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");

type HookInput = {
	readonly stop_hook_active?: unknown;
};

const input = await readStdinJson<HookInput>();
if (input?.stop_hook_active === true) process.exit(0);

const checklist = [
	"Session end checklist:",
	"- Archive completed projects? (work/active/ -> work/archive/YYYY/)",
	"- Update indexes? (Index.md, Memories.md, People & Context, Brag Doc)",
	"- New notes linked? (orphans are bugs)",
	"- Run /om-vault-audit if many notes were created/modified",
].join("\n");

// Concrete drift findings beat a generic checklist (#98/#103/#106): the
// same scan SessionStart runs, so the session closes against the same
// facts it opened with. Silent when clean.
const vaultRoot = process.env["CLAUDE_PROJECT_DIR"] || process.cwd();
let manifestJson: string | null = null;
try {
	manifestJson = readFileSync(join(vaultRoot, "vault-manifest.json"), {
		encoding: "utf-8",
	});
} catch {
	/* missing manifest → default open-loop config */
}
const hygieneLines = formatActiveHygiene(
	scanActiveHygiene(
		vaultRoot,
		Date.now(),
		parseOpenLoopConfig(manifestJson),
		parseInfraRootFilenames(manifestJson),
	),
);

process.stdout.write(
	checklist +
		(hygieneLines.length > 0
			? "\n\nVault Hygiene (drift detected):\n" + hygieneLines.join("\n")
			: "") +
		"\n",
);

triggerDebouncedRefresh({
	sentinelPath: SENTINEL_PATH,
	workerPath: WORKER_PATH,
	debounceMs: DEBOUNCE_MS,
	logPrefix: "stop-checklist",
});
