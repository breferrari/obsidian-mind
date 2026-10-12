/**
 * The test runner's process helpers (tests/_proc.ts, #337): listing the
 * qmd-refresh-run workers a run may leave behind, and killing each one's
 * whole tree, since a worker blocked in `qmd embed` has a live qmd child.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, listingCommand, listRefreshWorkers, parseProcessList } from "./_proc.ts";
import { rmTemp, waitFor } from "./_helpers.ts";

const fake = (r: Partial<SpawnSyncReturns<string>>) => () => r as SpawnSyncReturns<string>;

describe("listingCommand", () => {
	test("POSIX lists every process with its pid and untruncated arguments", () => {
		const { cmd, args } = listingCommand("linux");
		assert.equal(cmd, "ps");
		assert.deepEqual(args, ["-ax", "-ww", "-o", "pid=,args="]);
	});

	test("Windows filters on the command line, never on the node image name a version manager can rename", () => {
		const { cmd, args } = listingCommand("win32");
		assert.equal(cmd, "powershell");
		const script = args.join(" ");
		assert.match(script, /CommandLine LIKE '%qmd-refresh-run%'/);
		assert.doesNotMatch(script, /Name\s*=/);
	});

	test("Windows leaves out the listing's own PowerShell, whose command line holds the filter text", () => {
		assert.match(listingCommand("win32").args.join(" "), /ProcessId -ne \$PID/);
	});

	test("Windows writes UTF-8, so a non-ASCII path in a command line still matches", () => {
		assert.match(listingCommand("win32").args.join(" "), /\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/);
	});
});

describe("parseProcessList", () => {
	test("reads pid and command line from tab- or space-separated lines, skipping blanks", () => {
		const out = "  123 node a.ts --x\r\n\n456\tC:\\node.exe b.ts\n";
		assert.deepEqual(parseProcessList(out), [
			{ pid: 123, cmd: "node a.ts --x" },
			{ pid: 456, cmd: "C:\\node.exe b.ts" },
		]);
	});
});

describe("listRefreshWorkers", () => {
	test("a failed listing says why, so the caller reports 'not checked', never an empty 'none'", () => {
		const reason = (r: Partial<SpawnSyncReturns<string>>) => {
			const out = listRefreshWorkers(fake(r));
			assert.ok("failed" in out, "a failed listing must not read as a list");
			return out.failed;
		};
		assert.match(reason({ status: 1, stdout: "" }), /exit 1/);
		assert.match(reason({ status: null, error: new Error("spawn ps ENOENT"), stdout: "" }), /ENOENT/);
		assert.match(reason({ status: null, signal: "SIGTERM", stdout: "" }), /killed by SIGTERM/);
	});

	test("keeps only qmd-refresh-run workers", () => {
		const stdout = "1 node qmd-refresh-run.ts --trailing=x\n2 node other.ts\n";
		assert.deepEqual(listRefreshWorkers(fake({ status: 0, stdout })), {
			workers: [{ pid: 1, cmd: "node qmd-refresh-run.ts --trailing=x" }],
		});
	});
});

describe("killTree — outcomes", () => {
	test("Windows: taskkill's exit 128 (no such process) reads as already gone", () => {
		assert.equal(killTree(42, "win32", fake({ status: 0 })), "stopped");
		assert.equal(killTree(42, "win32", fake({ status: 128 })), "gone");
		assert.equal(killTree(42, "win32", fake({ status: 1 })), "failed");
	});

	test("POSIX: the process group first, then the bare pid when the worker leads no group", () => {
		const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		const calls: number[] = [];
		const groupless = (pid: number) => {
			calls.push(pid);
			if (pid < 0) throw esrch;
			return true;
		};
		assert.equal(killTree(42, "linux", undefined, groupless), "stopped");
		assert.deepEqual(calls, [-42, 42]);
		const gone = () => {
			throw esrch;
		};
		assert.equal(killTree(42, "linux", undefined, gone), "gone");
	});
});

describe("killTree — a real tree", () => {
	// A detached parent that starts a long-lived child and records its pid,
	// the shape of a refresh worker blocked in `qmd embed`. On Windows the
	// child is itself detached: otherwise libuv's job object would end it
	// with the parent and hide whether the kill reached it.
	test("stops the worker and the child it started", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proc-tree-"));
		const childPidFile = join(dir, "child.pid");
		const detachChild = process.platform === "win32";
		const parentScript =
			"const { spawn } = require('node:child_process'); const fs = require('node:fs');" +
			`const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: ${detachChild}, windowsHide: true });` +
			`fs.writeFileSync(${JSON.stringify(childPidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
		const parent = spawn(process.execPath, ["-e", parentScript], { detached: true, stdio: "ignore", windowsHide: true });
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		let childPid = 0;
		try {
			await waitFor(() => existsSync(childPidFile), 10_000);
			childPid = Number(readFileSync(childPidFile, "utf8"));
			assert.ok(childPid > 0 && alive(childPid), "the child never started");
			killTree(parent.pid!);
			await waitFor(() => !alive(childPid) && !alive(parent.pid!), 10_000);
			assert.equal(alive(parent.pid!), false, "the worker survived");
			assert.equal(alive(childPid), false, "the worker's child survived: only the worker's pid was killed");
		} finally {
			// Whatever the outcome, this test leaves nothing running.
			for (const pid of [childPid, parent.pid!]) {
				if (pid > 0 && alive(pid)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* gone */
					}
				}
			}
			rmTemp(dir);
		}
	});
});
