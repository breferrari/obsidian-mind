/**
 * Re-injecting the session context after a Gemini compression (#357).
 *
 * Gemini fires no SessionStart on compression, and its compression summarises
 * the early turn that carried the session context (gemini-cli
 * context/chatCompressionService.ts and ui/AppContainer.tsx, as of 29315e5).
 * So Gemini's PreCompress stores session-start's full context, and the next
 * BeforeAgent hands it over once. Claude Code and Codex re-inject on
 * SessionStart `compact` and are left alone.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reinjectSession, storeReinject, takeReinject } from "../lib/reinject.ts";
import { sessionStartContext } from "../lib/session-start-run.ts";
import { rmTemp } from "./_helpers.ts";

const withDir = (run: (dir: string) => void): void => {
	const dir = mkdtempSync(join(tmpdir(), "reinject-"));
	try {
		run(dir);
	} finally {
		rmTemp(dir);
	}
};

describe("reinjectSession", () => {
	test("Gemini's PreCompress gives its session", () => {
		assert.equal(reinjectSession({ hook_event_name: "PreCompress", session_id: "s1" }), "s1");
	});

	test("Claude Code's PreCompact gives none: it re-injects on SessionStart compact", () => {
		assert.equal(reinjectSession({ hook_event_name: "PreCompact", session_id: "s1" }), null);
	});

	test("no session, nothing to key it by", () => {
		assert.equal(reinjectSession({ hook_event_name: "PreCompress" }), null);
		assert.equal(reinjectSession({ hook_event_name: "PreCompress", session_id: "" }), null);
	});
});

describe("the stored context", () => {
	test("is taken once, by its own session", () => {
		withDir((dir) => {
			storeReinject(dir, "s1", "## Session Context\nvolatile");
			assert.equal(takeReinject(dir, "s2"), null, "another session's context is not this one's");
			assert.equal(takeReinject(dir, "s1"), "## Session Context\nvolatile");
			assert.equal(takeReinject(dir, "s1"), null, "once");
		});
	});

	test("an empty one gives nothing", () => {
		withDir((dir) => {
			storeReinject(dir, "s1", "  \n");
			assert.equal(takeReinject(dir, "s1"), null);
		});
	});

	test("a session id is reduced to a safe file name", () => {
		withDir((root) => {
			// One level down, so even an escaping write stays inside the temp folder and is cleaned up.
			const dir = join(root, "markers");
			storeReinject(dir, "../escape", "x");
			assert.equal(existsSync(join(root, "escape.reinject")), false);
			assert.equal(takeReinject(dir, "../escape"), "x");
		});
	});
});

describe("sessionStartContext", () => {
	const envelope = (context: string) =>
		JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });

	test("asks session-start for its full context, with no session to take a stored one", () => {
		const asked: Array<Record<string, unknown>> = [];
		const context = sessionStartContext((stdin) => (asked.push(stdin), { status: 0, stdout: envelope("## Session Context") }));
		assert.equal(context, "## Session Context");
		assert.equal(asked[0]?.["source"], "startup", "the full context: the compression summarised it away");
		assert.equal("session_id" in (asked[0] ?? {}), false);
	});

	test("a failed or empty run gives nothing", () => {
		assert.equal(sessionStartContext(() => ({ status: 1, stdout: envelope("a run that failed after printing") })), null);
		assert.equal(sessionStartContext(() => ({ status: 0, stdout: "not json" })), null);
		assert.equal(sessionStartContext(() => ({ status: 0, stdout: envelope("") })), null);
	});
});
