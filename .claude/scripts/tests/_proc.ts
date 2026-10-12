/**
 * Process helpers for the test runner (#337): finding the qmd-refresh-run
 * workers a run may leave behind, and stopping each one's whole tree.
 *
 * A worker can be blocked in `qmd embed` for up to five minutes, so killing
 * only its own pid would leave that qmd running. A detached worker leads its
 * own process group on POSIX, so the group is killed; Windows has no groups,
 * and `taskkill /T` walks the tree instead.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type Proc = { readonly pid: number; readonly cmd: string };

type Run = (cmd: string, args: readonly string[]) => SpawnSyncReturns<string>;

const run: Run = (cmd, args) =>
	spawnSync(cmd, args as string[], { encoding: "utf8", timeout: 60_000, windowsHide: true });

/**
 * The listing command for `platform`. Windows filters server-side on the
 * command line, never on the image name, which a Node version manager can
 * rename. POSIX lists everything with `-ww`, so a long command line is never
 * truncated before the match, and with the pid the kill needs.
 */
export function listingCommand(platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
	if (platform === "win32") {
		return {
			cmd: "powershell",
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%qmd-refresh-run%'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
			],
		};
	}
	return { cmd: "ps", args: ["-ax", "-ww", "-o", "pid=,args="] };
}

/** `{ pid, cmd }` for each `<pid><whitespace><command line>` line. */
export function parseProcessList(stdout: string): Proc[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => /^\s*(\d+)\s+(.*\S)\s*$/.exec(line))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => ({ pid: Number(m[1]), cmd: m[2]! }));
}

/**
 * The running qmd-refresh-run workers, or null when the listing failed
 * (missing `ps` or PowerShell, an error, a non-zero exit): the caller then
 * says the check did not run, rather than reporting none.
 */
export function listRefreshWorkers(runner: Run = run, platform: NodeJS.Platform = process.platform): Proc[] | null {
	const { cmd, args } = listingCommand(platform);
	const r = runner(cmd, args);
	if (r.error !== undefined || r.status !== 0 || typeof r.stdout !== "string") return null;
	return parseProcessList(r.stdout).filter((p) => p.pid !== process.pid && /qmd-refresh-run/.test(p.cmd));
}

/** Stop `pid` and every process it started. Best effort: a process already gone is fine. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
	if (platform === "win32") {
		run("taskkill", ["/T", "/F", "/PID", String(pid)]);
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* gone */
		}
	}
}
