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
type Kill = (pid: number, signal: NodeJS.Signals) => boolean;

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
				// UTF-8 out, so a non-ASCII path survives the pipe; and not this
				// PowerShell itself, whose own command line holds the filter text.
				"[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%qmd-refresh-run%'\" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
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
 * The running qmd-refresh-run workers, or why the listing failed (an error
 * such as a missing `ps` or PowerShell, a killing signal, a non-zero exit),
 * so the caller can say the check did not run rather than report none.
 */
export function listRefreshWorkers(
	runner: Run = run,
	platform: NodeJS.Platform = process.platform,
): { workers: Proc[] } | { failed: string } {
	const { cmd, args } = listingCommand(platform);
	const r = runner(cmd, args);
	if (r.error !== undefined) return { failed: `${cmd}: ${r.error.message}` };
	if (r.signal) return { failed: `${cmd} killed by ${r.signal}` };
	if (r.status !== 0 || typeof r.stdout !== "string") return { failed: `${cmd} exit ${r.status}` };
	return { workers: parseProcessList(r.stdout).filter((p) => p.pid !== process.pid && /qmd-refresh-run/.test(p.cmd)) };
}

const isEsrch = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ESRCH";

/**
 * Stop `pid` and every process it started. "gone" when it had already exited
 * (taskkill's exit 128; ESRCH on POSIX), "failed" when the kill itself did.
 * On POSIX the process group comes first; a worker that leads no group falls
 * back to its own pid.
 */
export function killTree(
	pid: number,
	platform: NodeJS.Platform = process.platform,
	runner: Run = run,
	kill: Kill = process.kill,
): "stopped" | "gone" | "failed" {
	if (platform === "win32") {
		const r = runner("taskkill", ["/T", "/F", "/PID", String(pid)]);
		return r.status === 0 ? "stopped" : r.status === 128 ? "gone" : "failed";
	}
	for (const target of [-pid, pid]) {
		try {
			kill(target, "SIGKILL");
			return "stopped";
		} catch (err) {
			if (!isEsrch(err)) return "failed";
		}
	}
	return "gone";
}
