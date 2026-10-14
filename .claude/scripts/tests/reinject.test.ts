/**
 * Re-injecting the session context after a Gemini compression (#357).
 *
 * Gemini fires no SessionStart on compression, and its compression summarises
 * the early turn that carried the session context (gemini-cli
 * context/chatCompressionService.ts and ui/AppContainer.tsx, as of 29315e5).
 * So Gemini's PreCompress marks the session, and the next BeforeAgent hands
 * over session-start's compact context once. Claude Code and Codex re-inject on
 * SessionStart `compact` and are left alone.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markReinject, reinjectContext, schedulesReinject, takeReinject } from "../lib/reinject.ts";
import { rmTemp } from "./_helpers.ts";

const withDir = (run: (dir: string) => void): void => {
	const dir = mkdtempSync(join(tmpdir(), "reinject-"));
	try {
		run(dir);
	} finally {
		rmTemp(dir);
	}
};

describe("schedulesReinject", () => {
	test("Gemini's PreCompress with a session schedules it", () => {
		assert.equal(schedulesReinject({ hook_event_name: "PreCompress", session_id: "s1" }), true);
	});

	test("Claude Code's PreCompact doesn't: it re-injects on SessionStart compact", () => {
		assert.equal(schedulesReinject({ hook_event_name: "PreCompact", session_id: "s1" }), false);
	});

	test("no session, nothing to key it by", () => {
		assert.equal(schedulesReinject({ hook_event_name: "PreCompress" }), false);
		assert.equal(schedulesReinject({ hook_event_name: "PreCompress", session_id: "" }), false);
	});
});

describe("the marker", () => {
	test("is taken once, per session", () => {
		withDir((dir) => {
			markReinject(dir, "s1");
			assert.equal(takeReinject(dir, "s2"), false, "another session's marker is not this one's");
			assert.equal(takeReinject(dir, "s1"), true);
			assert.equal(takeReinject(dir, "s1"), false, "once");
		});
	});

	test("a session id is reduced to a safe file name", () => {
		withDir((dir) => {
			markReinject(dir, "../escape");
			assert.equal(existsSync(join(dir, "..", "escape.reinject")), false);
			assert.equal(takeReinject(dir, "../escape"), true);
		});
	});
});

describe("reinjectContext", () => {
	const envelope = (context: string) =>
		JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });

	test("hands over session-start's compact context once after a mark, then nothing", () => {
		withDir((dir) => {
			const asked: Array<Record<string, unknown>> = [];
			const run = (stdin: Record<string, unknown>) => {
				asked.push(stdin);
				return { status: 0, stdout: envelope("## Session Context\nvolatile") };
			};
			markReinject(dir, "s1");
			assert.equal(reinjectContext(dir, "s1", run), "## Session Context\nvolatile");
			assert.equal(asked[0]?.["source"], "compact", "the compact form: only what changes");
			assert.equal(asked[0]?.["session_id"], "s1");
			assert.equal(reinjectContext(dir, "s1", run), null, "the next prompt gets nothing");
			assert.equal(asked.length, 1, "session-start ran once");
		});
	});

	test("without a mark, session-start doesn't run", () => {
		withDir((dir) => {
			let ran = false;
			assert.equal(reinjectContext(dir, "s1", () => ((ran = true), { status: 0, stdout: envelope("x") })), null);
			assert.equal(ran, false);
		});
	});

	test("a failed or empty run gives nothing, and the mark is spent rather than retried every prompt", () => {
		withDir((dir) => {
			markReinject(dir, "s1");
			assert.equal(reinjectContext(dir, "s1", () => ({ status: 1, stdout: envelope("a run that failed after printing") })), null);
			markReinject(dir, "s1");
			assert.equal(reinjectContext(dir, "s1", () => ({ status: 0, stdout: "not json" })), null);
			markReinject(dir, "s1");
			assert.equal(reinjectContext(dir, "s1", () => ({ status: 0, stdout: envelope("") })), null);
			assert.equal(takeReinject(dir, "s1"), false);
		});
	});
});
