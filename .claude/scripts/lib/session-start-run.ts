/**
 * session-start's full context, from a child run (#357). session-start.ts
 * can't be imported: it is a hook script whose work runs at the top level.
 * Only Gemini's PreCompress needs this (lib/reinject.ts), so it stays out of
 * the modules every prompt loads.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, parseHookContext } from "./hook-io.ts";
import { REFRESH_SWITCH } from "./qmd.ts";

/** Runs session-start with `stdin` as its hook input and returns its exit status and stdout. */
export type SessionStartRun = (stdin: Record<string, unknown>) => { readonly status: number | null; readonly stdout: string };

const SESSION_START = join(dirname(dirname(fileURLToPath(import.meta.url))), "session-start.ts");

/**
 * The child, hidden on Windows (#390). Bounded at 20 s, under the 30 s that
 * .gemini/settings.json gives PreCompress, which leaves the transcript backup
 * its share: a session-start run took 5-12 s on Windows CI (measured
 * 2026-10-13, #349). The refresh is off in the child: PreCompress already
 * started one.
 */
export const runSessionStart: SessionStartRun = (stdin) => {
	const r = spawnSync(process.execPath, ["--experimental-strip-types", SESSION_START], {
		input: JSON.stringify(stdin),
		encoding: "utf8",
		timeout: 20_000,
		windowsHide: true,
		env: { ...process.env, [REFRESH_SWITCH]: "off" },
	});
	return { status: r.status, stdout: r.stdout ?? "" };
};

/**
 * session-start's full context, or null when the run failed or gave nothing.
 * Asked as a startup, the form that carries every section, flagged so it
 * skips the qmd work startup already did; no session id, so the run never
 * takes a stored context itself.
 */
export function sessionStartContext(run: SessionStartRun = runSessionStart): string | null {
	const r = run({ hook_event_name: "SessionStart", source: "startup", om_reinject: true });
	if (r.status !== 0) {
		debug(`session-start run: exited ${r.status ?? "on a signal or timeout"}`);
		return null;
	}
	try {
		const context = parseHookContext(r.stdout, "SessionStart");
		if (context.trim() !== "") return context;
		debug("session-start run: empty context");
		return null;
	} catch (err) {
		debug(`session-start run: unreadable output: ${(err as Error).message}`);
		return null;
	}
}
