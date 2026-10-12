/**
 * `npm test`: run the suite with QMD's cache and config redirected to a temp
 * folder, and fail if the run still wrote into the user's own.
 *
 * Any test that spawns a hook script can reach a real `qmd`. SessionStart
 * derives an index name from its temp vault's folder and runs `qmd status`,
 * `update` or the bootstrap against it, and qmd writes
 * `<cache>/qmd/<index>.sqlite` (and can write `<config>/qmd/<index>.yml`)
 * for every name it meets. Left alone, every run on a machine with qmd
 * installed added one store per temp vault to the user's cache.
 *
 * This wrapper:
 * 1. records the stores (`.sqlite`) and configs (`.yml`) already in the
 *    user's qmd folders;
 * 2. sets `XDG_CACHE_HOME` and `QMD_CONFIG_DIR` to a fresh temp folder for
 *    the runner, which every test file and every subprocess inherits. qmd
 *    reads both (config: `QMD_CONFIG_DIR`, then `XDG_CONFIG_HOME/qmd`, then
 *    `~/.config/qmd`), and so do OM's own path helpers. `XDG_CONFIG_HOME`
 *    itself is left alone: it also moves git's global config, which the
 *    tests' git calls must keep seeing;
 * 3. sets `VAULT_QMD_REFRESH=off`, so no hook a test runs spawns the
 *    detached qmd-refresh-run worker, each of which outlived the run by
 *    ~30 s and made a qmd call (#337), and points `TMP`, `TEMP` and
 *    `TMPDIR` into that same temp folder, so a process a test leaves
 *    behind names it;
 * 4. after the run, stops and names any qmd-refresh-run worker still
 *    running from this run, and fails;
 * 5. fails if a new store or config appeared in the user's folders, naming
 *    each, then removes the temp folder.
 *
 * A test that builds a subprocess env from scratch, without `process.env`,
 * escapes the redirects; steps 4 and 5 are what catch it. The wrapper exists
 * because Node's runner applies `--import` to each test file's process and
 * never to itself, so a preload cannot see the run as a whole.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;
const watched: readonly { readonly dir: string; readonly ext: string }[] = [
	{ dir: join(env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "qmd"), ext: ".sqlite" },
	{
		dir: env["QMD_CONFIG_DIR"] ?? join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "qmd"),
		ext: ".yml",
	},
];

function listing(dir: string, ext: string): Set<string> {
	try {
		return new Set(readdirSync(dir).filter((f) => f.endsWith(ext)));
	} catch {
		return new Set();
	}
}

/**
 * Every running process as `{ pid, cmd }`, or null when the listing itself
 * fails (no PowerShell or `ps`): the guard below then warns instead of
 * failing, since it cannot tell.
 */
function processes(): { pid: number; cmd: string }[] | null {
	const r =
		process.platform === "win32"
			? spawnSync(
					"powershell",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
					],
					{ encoding: "utf8", timeout: 60_000, windowsHide: true },
				)
			: spawnSync("ps", ["-ax", "-o", "pid=,args="], { encoding: "utf8", timeout: 60_000 });
	if (r.status !== 0 || typeof r.stdout !== "string") return null;
	return r.stdout
		.split(/\r?\n/)
		.map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => ({ pid: Number(m[1]), cmd: m[2]! }));
}

/** Comparable form of a path inside a command line: forward slashes, lower case. */
const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();

const before = watched.map(({ dir, ext }) => listing(dir, ext));
const isolated = mkdtempSync(join(tmpdir(), "om-test-qmd-"));
const isolatedTmp = join(isolated, "tmp");
mkdirSync(isolatedTmp, { recursive: true });

const run = spawnSync(
	process.execPath,
	["--experimental-strip-types", "--import", "./tests/_qmd-cache-guard.ts", "--test", ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: {
			...env,
			XDG_CACHE_HOME: join(isolated, "cache"),
			QMD_CONFIG_DIR: join(isolated, "config", "qmd"),
			OM_QMD_ISOLATED: isolated,
			// No detached qmd-refresh-run worker from any hook a test runs
			// (#337): each one outlived the run by ~30 s and made a qmd call.
			VAULT_QMD_REFRESH: "off",
			// Temp folders inside the isolated one, so any process a test leaves
			// behind names it, and the guard below can attribute it to this run.
			TMP: isolatedTmp,
			TEMP: isolatedTmp,
			TMPDIR: isolatedTmp,
		},
	},
);

// A refresh worker still alive from this run means some hook ran without the
// switch (a test that built its env from scratch, or the switch no longer
// honoured). Every one is stopped before reporting, so a red run leaves
// nothing behind either.
const listed = processes();
const survivors = (listed ?? []).filter(
	({ pid, cmd }) => pid !== process.pid && /qmd-refresh-run/.test(cmd) && norm(cmd).includes(norm(isolated)),
);
for (const { pid } of survivors) {
	try {
		process.kill(pid);
	} catch {
		/* already gone */
	}
}

const added = watched.flatMap(({ dir, ext }, i) =>
	[...listing(dir, ext)].filter((f) => !before[i]!.has(f)).sort().map((f) => join(dir, f)),
);
try {
	rmSync(isolated, { recursive: true, force: true });
} catch {
	/* a detached qmd may still hold a file; the OS cleans temp */
}

if (listed === null) {
	process.stderr.write("\nrefresh-worker guard: could not list processes; surviving qmd-refresh-run workers were not checked.\n");
}
if (survivors.length > 0) {
	process.stderr.write(
		`\nrefresh-worker guard: the test run left ${survivors.length} qmd-refresh-run worker(s) alive (now stopped):\n` +
			survivors.map(({ pid, cmd }) => `  ${pid} ${cmd}`).join("\n") +
			"\nA hook ran without VAULT_QMD_REFRESH=off. Route its subprocess env through process.env (#337).\n",
	);
	process.exit(1);
}
if (added.length > 0) {
	process.stderr.write(
		`\nqmd cache guard: the test run created ${added.length} file(s) in the user's qmd folders:\n` +
			added.map((f) => `  ${f}`).join("\n") +
			"\nA test reached qmd with the user's environment. Route its subprocess env through process.env.\n",
	);
	process.exit(1);
}
process.exit(run.status ?? 1);
