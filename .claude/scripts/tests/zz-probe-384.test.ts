/**
 * THROWAWAY probe for #384, windows-latest only: how many conhost.exe one
 * background job creates, today's detached spawn versus a `start /b` in a
 * windowless cmd console, each launched by a short-lived "hook" process that
 * exits at once. Reports only, never fails. Not for merge.
 */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The background job: three console children, two like our own spawns
// (windowsHide) and one like qmd's own (no flag), then a marker.
const WORKER = String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [out] = process.argv.slice(2);
const pids = [process.pid];
for (const hide of [true, true, false]) {
	const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { windowsHide: hide, stdio: "pipe" });
	pids.push(c.pid);
}
writeFileSync(out + ".pids", JSON.stringify(pids));
setTimeout(() => { writeFileSync(out + ".alive", "yes"); process.exit(0); }, 3000);
`;

// The "hook": launches the job one way or the other, prints the launcher's pid, exits.
const HOOK = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const [how, worker, out] = process.argv.slice(2);
if (how === "a") {
	const c = spawn(process.execPath, [worker, out], { detached: true, stdio: "ignore", windowsHide: true });
	c.unref();
	process.stdout.write(String(c.pid));
} else {
	const line = 'start "" /b "' + process.execPath + '" "' + worker + '" "' + out + '"';
	const r = spawnSync("cmd.exe", ["/d", "/s", "/c", line], { windowsHide: true, stdio: "ignore", windowsVerbatimArguments: true });
	process.stdout.write(String(r.pid) + " status=" + r.status);
}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function conhostParents(): number[] {
	const ps = spawnSync(
		"powershell.exe",
		["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='conhost.exe'\" | ForEach-Object { $_.ParentProcessId }"],
		{ encoding: "utf8", windowsHide: true },
	);
	return (ps.stdout ?? "").split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0);
}

test("probe #384: conhost.exe per background job", { skip: process.platform !== "win32" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "probe384-"));
	const worker = join(dir, "worker.cjs");
	const hook = join(dir, "hook.cjs");
	writeFileSync(worker, WORKER);
	writeFileSync(hook, HOOK);

	for (const [how, label] of [["a", "detached (today)"], ["c", "cmd start /b (c)"]] as const) {
		const out = join(dir, how);
		const h = spawnSync(process.execPath, [hook, how, worker, out], { encoding: "utf8", windowsHide: true });
		const launcher = Number((h.stdout ?? "").split(" ")[0]);
		t.diagnostic(`${label}: hook exited ${h.status}, launcher ${h.stdout}`);
		await sleep(1500);
		const pids = existsSync(out + ".pids") ? (JSON.parse(readFileSync(out + ".pids", "utf8")) as number[]) : [];
		const tree = [launcher, ...pids];
		const mine = conhostParents().filter((p) => tree.includes(p));
		t.diagnostic(`${label}: tree ${JSON.stringify(tree)}; conhost.exe owned by it: ${mine.length} (parents ${JSON.stringify(mine)})`);
		await sleep(2500);
		t.diagnostic(`${label}: worker outlived the hook and finished: ${existsSync(out + ".alive")}`);
	}
});
