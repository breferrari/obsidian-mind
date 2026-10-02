/**
 * Unit tests for lib/project-dir.ts — which project directory a hook runs
 * against, whichever of the three agents called it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveProjectDir } from "../lib/project-dir.ts";

describe("resolveProjectDir", () => {
	test("each agent's variable is honoured", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: "/c" }), "/c");
		assert.equal(resolveProjectDir("/fb", { CODEX_PROJECT_DIR: "/x" }), "/x");
		assert.equal(resolveProjectDir("/fb", { GEMINI_PROJECT_DIR: "/g" }), "/g");
	});

	test("Claude, then Codex, then Gemini", () => {
		const all = { CLAUDE_PROJECT_DIR: "/c", CODEX_PROJECT_DIR: "/x", GEMINI_PROJECT_DIR: "/g" };
		assert.equal(resolveProjectDir("/fb", all), "/c");
		assert.equal(resolveProjectDir("/fb", { CODEX_PROJECT_DIR: "/x", GEMINI_PROJECT_DIR: "/g" }), "/x");
	});

	test("an empty value counts as unset", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: "", CODEX_PROJECT_DIR: "/x" }), "/x");
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: "" }), "/fb");
	});

	test("no variable falls back to the caller's choice", () => {
		assert.equal(resolveProjectDir("/fb", {}), "/fb");
	});
});
