/**
 * Every test process runs with the detached qmd refresh switched off (#337),
 * whether it was started by `npm test` (tests/_run-tests.ts sets it) or by a
 * direct `node --import ./tests/_qmd-cache-guard.ts --test <file>` run (the
 * preload sets it). Otherwise any hook a test runs leaves a qmd-refresh-run
 * worker behind, which outlives the run and makes a qmd call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { REFRESH_SWITCH } from "../lib/qmd-refresh.ts";

test("this test process sees the refresh switch off", () => {
	assert.equal(process.env[REFRESH_SWITCH], "off");
});
