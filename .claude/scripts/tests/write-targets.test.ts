/**
 * writeTargets: the files a write hook's payload says were written. Claude
 * Code and Gemini name one `file_path`; Codex's apply_patch names none and
 * carries the raw patch in `tool_input.command` (#354).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { writeTargets } from "../lib/write-targets.ts";

const PROJECT = resolve("/vault");
const CWD = resolve("/vault/work");

/** A Codex apply_patch payload for `patch`, run in `cwd`. */
const applyPatch = (patch: string, cwd: string = CWD) => ({
	hook_event_name: "PostToolUse",
	tool_name: "apply_patch",
	cwd,
	tool_input: { command: patch },
});

const patch = (...hunks: string[]) => ["*** Begin Patch", ...hunks, "*** End Patch", ""].join("\n");

describe("writeTargets — file_path (Claude Code, Gemini)", () => {
	test("a file_path is the one target, as given", () => {
		assert.deepEqual(writeTargets({ tool_input: { file_path: join(PROJECT, "a.md") } }, PROJECT), [join(PROJECT, "a.md")]);
	});

	test("no tool_input, or neither field, gives no target", () => {
		assert.deepEqual(writeTargets(null, PROJECT), []);
		assert.deepEqual(writeTargets({}, PROJECT), []);
		assert.deepEqual(writeTargets({ tool_input: { file_path: "" } }, PROJECT), []);
	});
});

describe("writeTargets — Codex apply_patch (#354)", () => {
	// Markers from openai/codex apply-patch/src/parser.rs, as of 2026-10-13.
	test("an added file is a target, resolved against the payload's cwd", () => {
		const input = applyPatch(patch("*** Add File: notes/a.md", "+hello"));
		assert.deepEqual(writeTargets(input, PROJECT), [join(CWD, "notes/a.md")]);
	});

	test("an updated file is a target, and a move targets where it lands", () => {
		const input = applyPatch(
			patch("*** Update File: b.md", "@@", "-old", "+new", "*** Update File: c.md", "*** Move to: d.md", "@@", "-x", "+y"),
		);
		assert.deepEqual(writeTargets(input, PROJECT), [join(CWD, "b.md"), join(CWD, "d.md")]);
	});

	test("a deleted file is not a target: there is nothing left to validate", () => {
		assert.deepEqual(writeTargets(applyPatch(patch("*** Delete File: gone.md")), PROJECT), []);
	});

	test("every file in a patch is a target, once each", () => {
		const input = applyPatch(patch("*** Add File: a.md", "+1", "*** Update File: b.md", "@@", "+2", "*** Update File: a.md", "@@", "+3"));
		assert.deepEqual(writeTargets(input, PROJECT), [join(CWD, "a.md"), join(CWD, "b.md")]);
	});

	test("an absolute path stays as written", () => {
		const abs = resolve("/elsewhere/x.md");
		assert.deepEqual(writeTargets(applyPatch(patch(`*** Add File: ${abs}`, "+1")), PROJECT), [abs]);
	});

	test("without a cwd, relative paths resolve against the project dir", () => {
		const input = { tool_name: "apply_patch", tool_input: { command: patch("*** Add File: a.md", "+1") } };
		assert.deepEqual(writeTargets(input, PROJECT), [join(PROJECT, "a.md")]);
	});

	test("a CRLF patch reads the same", () => {
		const input = applyPatch(patch("*** Add File: a.md", "+1").replaceAll("\n", "\r\n"));
		assert.deepEqual(writeTargets(input, PROJECT), [join(CWD, "a.md")]);
	});

	test("a command with no patch markers gives no target", () => {
		assert.deepEqual(writeTargets(applyPatch("echo hello"), PROJECT), []);
		assert.deepEqual(writeTargets({ tool_name: "apply_patch", tool_input: { command: 42 } }, PROJECT), []);
	});

	test("a header naming no file, or a move with no update before it, gives no target", () => {
		assert.deepEqual(writeTargets(applyPatch(patch("*** Add File: ", "+1")), PROJECT), []);
		assert.deepEqual(writeTargets(applyPatch(patch("*** Move to: stray.md")), PROJECT), []);
		assert.deepEqual(writeTargets(applyPatch("*** Begin Patch\n*** Add File: cut.md"), PROJECT), [join(CWD, "cut.md")]);
	});

	test("a file line inside a hunk's body is content, not a target", () => {
		const input = applyPatch(patch("*** Add File: a.md", "+*** Add File: not-a-target.md"));
		assert.deepEqual(writeTargets(input, PROJECT), [join(CWD, "a.md")]);
	});
});
