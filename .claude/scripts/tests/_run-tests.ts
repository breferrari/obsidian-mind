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
 * 3. after the run, fails if a new store or config appeared in the user's
 *    folders, naming each, then removes the temp folder.
 *
 * A test that builds a subprocess env from scratch, without `process.env`,
 * escapes the redirect; step 3 is what catches it. The wrapper exists
 * because Node's runner applies `--import` to each test file's process and
 * never to itself, so a preload cannot see the run as a whole.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const before = watched.map(({ dir, ext }) => listing(dir, ext));
const isolated = mkdtempSync(join(tmpdir(), "om-test-qmd-"));

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
		},
	},
);

const added = watched.flatMap(({ dir, ext }, i) =>
	[...listing(dir, ext)].filter((f) => !before[i]!.has(f)).sort().map((f) => join(dir, f)),
);
try {
	rmSync(isolated, { recursive: true, force: true });
} catch {
	/* a detached qmd may still hold a file; the OS cleans temp */
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
