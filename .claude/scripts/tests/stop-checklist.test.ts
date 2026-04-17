/**
 * Integration tests for the Stop hook entry point.
 * Locks the stop_hook_active bool-check semantics and the default-print
 * behavior on malformed or missing input.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runScript as spawnHook } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../stop-checklist.ts",
);
const runScript = (stdin: string | object | null) => spawnHook(SCRIPT, stdin);

describe("stop-checklist", () => {
	test("silent when stop_hook_active is strict boolean true", () => {
		const { stdout, code } = runScript({ stop_hook_active: true });
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});

	test("prints checklist when stop_hook_active is false", () => {
		const { stdout, code } = runScript({ stop_hook_active: false });
		assert.equal(code, 0);
		assert.match(stdout, /Session end checklist:/);
		assert.match(stdout, /Archive completed projects/);
	});

	test("prints checklist when stop_hook_active is string 'true' (not strict)", () => {
		const { stdout } = runScript({ stop_hook_active: "true" });
		assert.match(stdout, /Session end checklist:/);
	});

	test("prints checklist when field is absent", () => {
		const { stdout } = runScript({});
		assert.match(stdout, /Session end checklist:/);
	});

	test("prints checklist on malformed JSON (safe default)", () => {
		const { stdout, code } = runScript("garbage{{");
		assert.equal(code, 0);
		assert.match(stdout, /Session end checklist:/);
	});

	test("prints checklist on empty stdin", () => {
		const { stdout, code } = runScript(null);
		assert.equal(code, 0);
		assert.match(stdout, /Session end checklist:/);
	});
});
