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
	const fake = (r: Partial<SpawnSyncReturns<string>>) => () => r as SpawnSyncReturns<string>;

	test("a failed listing is null (not checked), never an empty 'none'", () => {
		assert.equal(listRefreshWorkers(fake({ status: 1, stdout: "" })), null);
		assert.equal(listRefreshWorkers(fake({ status: null, error: new Error("ENOENT"), stdout: "" })), null);
	});

	test("keeps only qmd-refresh-run workers", () => {
		const stdout = "1 node qmd-refresh-run.ts --trailing=x\n2 node other.ts\n";
		assert.deepEqual(listRefreshWorkers(fake({ status: 0, stdout })), [{ pid: 1, cmd: "node qmd-refresh-run.ts --trailing=x" }]);
	});
});

describe("killTree", () => {
	// A detached parent that starts a long-lived child and records its pid,
	// the shape of a refresh worker blocked in `qmd embed`.
	test("stops the worker and the child it started", async () => {
		const dir = mkdtempSync(join(tmpdir(), "proc-tree-"));
		const childPidFile = join(dir, "child.pid");
		const parentScript =
			"const { spawn } = require('node:child_process'); const fs = require('node:fs');" +
			"const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
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
