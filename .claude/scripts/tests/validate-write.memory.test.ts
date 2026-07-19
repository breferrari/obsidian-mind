/**
 * Subprocess integration tests for validate-write.ts's memory-location
 * guard (#81) — fires only on writes inside ~/.claude/…/memory/, allows
 * MEMORY.md, silent on everything else, and emits the machine-readable
 * policy result (#117) alongside the prose. Vault-file cases stay silent
 * here because the test paths fall outside the subprocess's vault root
 * (cwd), hitting the outside-vault skip.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runScript as spawnHook } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../validate-write.ts",
);

const runScript = (stdin: object | null) => spawnHook(SCRIPT, stdin);
const runOn = (filePath: string) =>
	runScript({ tool_input: { file_path: filePath } });

describe("validate-write memory guard — fires on misplaced memory files", () => {
	test("warns on a non-MEMORY.md file in memory dir", () => {
		const { stdout, code } = runOn(
			"/Users/foo/.claude/projects/-Users-foo-dev-bar/memory/feedback_x.md",
		);
		assert.equal(code, 0);
		assert.match(stdout, /Memory location violation/);
		assert.match(stdout, /feedback_x\.md/);
		assert.match(stdout, /brain\//);
	});

	test("emits the machine-readable policy result next to the prose (#117)", () => {
		const { stdout } = runOn(
			"/Users/foo/.claude/projects/-Users-foo-dev-bar/memory/notes.md",
		);
		const parsed = JSON.parse(stdout) as {
			hookSpecificOutput: { policyResults?: unknown[] };
		};
		assert.deepEqual(parsed.hookSpecificOutput.policyResults, [
			{
				policy_id: "memory-location",
				path: "/Users/foo/.claude/projects/-Users-foo-dev-bar/memory/notes.md",
				classification: "misplaced-memory",
				suggested_target: "brain/",
				action: "warn",
			},
		]);
	});

	test("warns on Windows-style backslash path", () => {
		const { stdout, code } = runOn(
			"C:\\Users\\foo\\.claude\\projects\\-bar\\memory\\project_y.md",
		);
		assert.equal(code, 0);
		assert.match(stdout, /Memory location violation/);
		assert.match(stdout, /project_y\.md/);
	});

	test("catches dot-dot spellings that resolve into the memory dir", () => {
		const { stdout, code } = runOn(
			"/Users/foo/.claude/projects/-bar/transcripts/../memory/sneaky.md",
		);
		assert.equal(code, 0);
		assert.match(stdout, /Memory location violation/);
	});
});

describe("validate-write memory guard — silent on allowed paths", () => {
	test("silent on MEMORY.md in memory dir", () => {
		const { stdout, code } = runOn(
			"/Users/foo/.claude/projects/-Users-foo-dev-bar/memory/MEMORY.md",
		);
		assert.equal(code, 0);
		assert.equal(stdout, "");
	});

	test("silent on other .claude/projects subdirs (transcripts, hook output)", () => {
		const { stdout } = runOn(
			"/Users/foo/.claude/projects/-bar/transcripts/session.md",
		);
		assert.equal(stdout, "");
	});

	test("silent on vault paths containing the word memory", () => {
		const { stdout } = runOn("/vault/brain/Memories.md");
		assert.equal(stdout, "");
	});

	test("silent on paths that lexically mention memory/ but normalize out of it", () => {
		// A naive substring predicate false-positives here; the normalized
		// path lands in transcripts/, which is allowed.
		const { stdout } = runOn(
			"/Users/foo/.claude/projects/-bar/memory/../transcripts/notes.md",
		);
		assert.equal(stdout, "");
	});
});
