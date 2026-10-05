/**
 * Per-process redirect of QMD's cache and config, for a direct
 * `node --import ./tests/_qmd-cache-guard.ts --test` run.
 *
 * `npm test` goes through `_run-tests.ts`, which sets the redirect once for
 * the whole run and checks the user's folders afterwards; this module then
 * sees `OM_QMD_ISOLATED` and does nothing. Node's test runner applies
 * `--import` only to the child process of each test FILE, never to the
 * runner, so without the wrapper each file gets its own temp folders here.
 *
 * See `_run-tests.ts` for why the redirect exists.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env["OM_QMD_ISOLATED"] === undefined) {
	const isolated = mkdtempSync(join(tmpdir(), "om-test-qmd-"));
	process.env["XDG_CACHE_HOME"] = join(isolated, "cache");
	process.env["QMD_CONFIG_DIR"] = join(isolated, "config", "qmd");
	process.env["OM_QMD_ISOLATED"] = isolated;
	process.on("exit", () => {
		try {
			rmSync(isolated, { recursive: true, force: true });
		} catch {
			/* a detached qmd may still hold a file; the OS cleans temp */
		}
	});
}
