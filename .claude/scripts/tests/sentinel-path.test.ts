/**
 * Where the QMD refresh debounce keeps its sentinel (#360). An empty or blank
 * QMD_REFRESH_SENTINEL counts as unset: passed through as the path "", the
 * sentinel could be neither read nor written, so every write, Stop and
 * PreCompact spawned a refresh worker with no debounce, and nothing showed it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sentinelPathFrom } from "../lib/qmd-refresh.ts";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));

describe("sentinelPathFrom", () => {
	const dir = join("scripts", "dir");
	const fallback = join(dir, ".qmd-refresh-sentinel");

	test("unset is the default path beside the scripts", () => {
		assert.equal(sentinelPathFrom({}, dir), fallback);
	});

	test("empty or blank is unset too, not the path \"\"", () => {
		assert.equal(sentinelPathFrom({ QMD_REFRESH_SENTINEL: "" }, dir), fallback);
		assert.equal(sentinelPathFrom({ QMD_REFRESH_SENTINEL: "  " }, dir), fallback);
	});

	test("a set value is honoured as given", () => {
		const mine = join("elsewhere", "my.sentinel");
		assert.equal(sentinelPathFrom({ QMD_REFRESH_SENTINEL: mine }, dir), mine);
	});
});

// The hooks read the sentinel through the helper, not a copy of the old `??`.
test("no hook reads QMD_REFRESH_SENTINEL directly", () => {
	for (const hook of ["validate-write.ts", "stop-checklist.ts", "pre-compact.ts"]) {
		const source = readFileSync(join(SCRIPTS, hook), "utf8");
		assert.ok(!/process\.env\[["']QMD_REFRESH_SENTINEL["']\]/.test(source), `${hook} reads the variable itself`);
		assert.ok(source.includes("sentinelPathFrom("), `${hook} does not use sentinelPathFrom`);
	}
});
