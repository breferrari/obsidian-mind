#!/usr/bin/env node
/**
 * Stop hook — remind the user of session-wrap-up tasks.
 *
 * Silently exits when the hook is being re-entered by a secondary agent
 * (stop_hook_active=true) to avoid recursive reminder output. Otherwise
 * prints a short vault-hygiene checklist.
 */

import { readStdinJson } from "./lib/hook-io.ts";

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

process.stdout.write(checklist + "\n");
