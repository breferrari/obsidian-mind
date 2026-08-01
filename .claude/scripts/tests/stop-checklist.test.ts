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
const runJsonScript = (stdin: string | object | null) =>
	spawnHook(SCRIPT, stdin, undefined, ["--json"]);

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

	test("emits valid Codex Stop JSON when --json is passed", () => {
		const { stdout, code } = runJsonScript({
			hook_event_name: "Stop",
			stop_hook_active: false,
		});
		assert.equal(code, 0);
		const output = JSON.parse(stdout) as { systemMessage?: unknown };
		assert.equal(typeof output.systemMessage, "string");
		assert.match(output.systemMessage as string, /Session end checklist:/);
		assert.match(output.systemMessage as string, /Archive completed projects/);
	});

	test("auto-detects Codex input for sessions that loaded the old command", () => {
		const { stdout, code } = runScript({
			hook_event_name: "Stop",
			model: "gpt-5.6-sol",
			stop_hook_active: false,
		});
		assert.equal(code, 0);
		const output = JSON.parse(stdout) as { systemMessage?: unknown };
		assert.match(output.systemMessage as string, /Session end checklist:/);
	});

	test("Codex JSON mode remains valid on malformed input", () => {
		const { stdout, code } = runJsonScript("garbage{{");
		assert.equal(code, 0);
		assert.doesNotThrow(() => JSON.parse(stdout));
	});
});
