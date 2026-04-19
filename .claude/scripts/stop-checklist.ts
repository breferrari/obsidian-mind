#!/usr/bin/env node
/**
 * Stop hook — remind the user of session-wrap-up tasks and kick a
 * detached QMD refresh so the next session opens against a current index.
 *
 * Silently exits when the hook is being re-entered by a secondary agent
 * (stop_hook_active=true) to avoid recursive reminder output and
 * duplicated refresh spawns. Otherwise prints the vault-hygiene
 * checklist and fires the same fire-and-forget worker the PostToolUse
 * hook uses. Both write paths converge on one detached Node process so
 * there's exactly one debounce contract and one spawn shape to maintain.
 */

import { spawn } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, readStdinJson } from "./lib/hook-io.ts";
import { resolveQmdEntry } from "./lib/qmd.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");

type HookInput = {
	readonly stop_hook_active?: unknown;
};

function spawnRefreshWorker(): void {
	if (resolveQmdEntry() === null) {
		debug("stop-checklist: qmd not resolvable; skipping refresh");
		return;
	}
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
		debug(`stop-checklist: worker spawn error: ${err.message}`);
	});
	child.unref();
}

const input = await readStdinJson<HookInput>();
if (input?.stop_hook_active === true) process.exit(0);

const checklist = [
	"Session end checklist:",
	"- Archive completed projects? (work/active/ -> work/archive/YYYY/)",
	"- Update indexes? (Index.md, Memories.md, People & Context, Brag Doc)",
	"- New notes linked? (orphans are bugs)",
	"- Run /om-vault-audit if many notes were created/modified",
].join("\n");

process.stdout.write(checklist + "\n");

spawnRefreshWorker();
