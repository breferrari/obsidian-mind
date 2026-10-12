/**
 * Every test process, and every hook a test runs, sees the detached qmd
 * refresh switched off (#337). Three places hold it, so no route around one
 * of them leaks a qmd-refresh-run worker:
 * - `npm test` (tests/_run-tests.ts) sets it for the whole run;
 * - the preload (tests/_qmd-cache-guard.ts) forces it in every test process,
 *   so a direct `node --import ./tests/_qmd-cache-guard.ts --test <file>`
 *   run is covered and an exported "on" cannot leak through;
 * - `runScript` (tests/_helpers.ts) sets it in every hook's env, the one
 *   choke point every launcher goes through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REFRESH_SWITCH } from "../lib/qmd-refresh.ts";
import { rmTemp, runScript } from "./_helpers.ts";

const testsDir = dirname(fileURLToPath(import.meta.url));

test("this test process sees the refresh switch off, wherever the preload or runner ran", (t) => {
	// A bare `node --test` (CI's test-without-qmd leg, the release job) loads
	// neither, so this process has no switch; every hook it runs still gets it
	// from runScript, which the last test below pins. OM_QMD_ISOLATED is set by
	// both the preload and the runner, so it says whether either ran.
	if (process.env["OM_QMD_ISOLATED"] === undefined) {
		t.skip("bare node --test: no preload or runner, so the switch reaches hooks through runScript only");
		return;
	}
	assert.equal(process.env[REFRESH_SWITCH], "off");
});

test("the preload forces the switch off, even over an exported 'on' or ''", () => {
	for (const exported of ["on", ""]) {
		const r = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				// A file URL: a bare Windows path's drive letter reads as a URL scheme.
				pathToFileURL(join(testsDir, "_qmd-cache-guard.ts")).href,
				"-e",
				`process.stdout.write(String(process.env.${REFRESH_SWITCH}))`,
			],
			{ encoding: "utf8", timeout: 30_000, env: { ...process.env, [REFRESH_SWITCH]: exported } },
		);
		assert.equal(r.stdout, "off", `with ${REFRESH_SWITCH}=${JSON.stringify(exported)} exported`);
	}
});

test("runScript gives every hook it runs the switch, even when this process lacks it", () => {
	const dir = mkdtempSync(join(tmpdir(), "refresh-switch-probe-"));
	const probe = join(dir, "probe.mjs");
	writeFileSync(probe, `process.stdout.write(String(process.env.${REFRESH_SWITCH}));\n`);
	const before = process.env[REFRESH_SWITCH];
	delete process.env[REFRESH_SWITCH];
	try {
		assert.equal(runScript(probe, null).stdout, "off");
	} finally {
		if (before !== undefined) process.env[REFRESH_SWITCH] = before;
		rmTemp(dir);
	}
});
