/**
 * Paths the environment may override for the hooks' state files (#360). An
 * empty or blank value counts as unset: passed through as the path "", the
 * QMD refresh sentinel could be neither read nor written, so every write,
 * Stop and PreCompact spawned a refresh worker with no debounce, and nothing
 * showed it. The Stop checklist's dedupe store, the classifier's hint store
 * and the Stop handoff folder were read the same way.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { envPath } from "../lib/env-path.ts";
import { sentinelPathFrom } from "../lib/qmd-refresh.ts";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));

describe("envPath", () => {
	const fallback = join("scripts", "dir", ".state.json");

	test("unset is the fallback", () => {
		assert.equal(envPath({}, "SOME_STATE", fallback), fallback);
	});

	test("empty or blank is unset too, not the path \"\"", () => {
		assert.equal(envPath({ SOME_STATE: "" }, "SOME_STATE", fallback), fallback);
		assert.equal(envPath({ SOME_STATE: "  " }, "SOME_STATE", fallback), fallback);
	});

	test("a set value is honoured as given", () => {
		const mine = join("elsewhere", "my.state");
		assert.equal(envPath({ SOME_STATE: mine }, "SOME_STATE", fallback), mine);
	});
});

describe("sentinelPathFrom", () => {
	test("an empty QMD_REFRESH_SENTINEL is the default path beside the scripts", () => {
		const dir = join("scripts", "dir");
		assert.equal(sentinelPathFrom({ QMD_REFRESH_SENTINEL: "" }, dir), resolve(dir, ".qmd-refresh-sentinel"));
	});
});

// Every one of these is read through envPath, never with a bare `??` again.
test("no script reads a state-path variable directly", () => {
	const names = ["QMD_REFRESH_SENTINEL", "STOP_CHECKLIST_STATE", "CLASSIFY_HINT_STATE", "STOP_HANDOFF_DIR"];
	const direct = new RegExp(`process\\.env(?:\\[["'](?:${names.join("|")})["']\\]|\\.(?:${names.join("|")})\\b)`);
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			if (name === "node_modules" || name === "tests") return [];
			const path = join(dir, name);
			return statSync(path).isDirectory() ? walk(path) : /\.(ts|mjs)$/.test(name) ? [path] : [];
		});
	const offenders = walk(SCRIPTS).filter((file) => direct.test(readFileSync(file, "utf8")));
	assert.deepEqual(offenders.map((f) => relative(SCRIPTS, f)), []);
});
