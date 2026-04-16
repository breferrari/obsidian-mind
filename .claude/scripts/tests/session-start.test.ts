/**
 * Unit tests for session-start pure helpers.
 * The entry point itself (fs walk, git log, Obsidian CLI probe) is exercised
 * live when the hook fires; these tests lock the deterministic formatting
 * logic that doesn't need a real environment.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	take,
	formatDateHeader,
	formatActiveWork,
	formatRecentChanges,
	isSkippedPath,
} from "../lib/session-start.ts";

describe("take", () => {
	test("keeps first N lines", () => {
		assert.equal(take("a\nb\nc\nd", 2), "a\nb");
	});
	test("N >= line count is a pass-through", () => {
		assert.equal(take("a\nb", 10), "a\nb");
	});
	test("empty string stays empty", () => {
		assert.equal(take("", 5), "");
	});
});

describe("formatDateHeader", () => {
	test("pads single-digit month and day; includes weekday", () => {
		const d = new Date(2026, 3, 5, 12, 0, 0); // April 5, 2026 (Sunday)
		assert.equal(formatDateHeader(d), "2026-04-05 (Sunday)");
	});
	test("double-digit components pass through", () => {
		const d = new Date(2026, 11, 25, 12, 0, 0); // December 25, 2026 (Friday)
		assert.equal(formatDateHeader(d), "2026-12-25 (Friday)");
	});
});

describe("formatActiveWork", () => {
	test("strips .md, respects limit, returns sorted input order", () => {
		const out = formatActiveWork(
			["project-a.md", "project-b.md", "project-c.md"],
			2,
		);
		assert.equal(out, "project-a\nproject-b");
	});
	test("filters out non-.md files", () => {
		const out = formatActiveWork(
			["a.md", "b.txt", "c.md", ".DS_Store"],
			10,
		);
		assert.equal(out, "a\nc");
	});
	test("empty input → '(none)'", () => {
		assert.equal(formatActiveWork([], 10), "(none)");
	});
	test("all-filtered-out → '(none)'", () => {
		assert.equal(formatActiveWork(["not-markdown.txt"], 10), "(none)");
	});
});

describe("formatRecentChanges", () => {
	test("filters blank lines, respects limit", () => {
		const out = formatRecentChanges("abc123 one\n\ndef456 two\n\nghi789 three", 2);
		assert.equal(out, "abc123 one\ndef456 two");
	});
	test("empty git output → '(no git history)'", () => {
		assert.equal(formatRecentChanges("", 15), "(no git history)");
	});
	test("whitespace-only git output → '(no git history)'", () => {
		assert.equal(formatRecentChanges("\n\n\n", 15), "(no git history)");
	});
});

describe("isSkippedPath", () => {
	const PREFIXES = [".git", ".obsidian", "thinking", ".claude"];

	test("exact prefix match is skipped", () => {
		assert.equal(isSkippedPath(".git", PREFIXES), true);
	});
	test("child of prefix is skipped", () => {
		assert.equal(isSkippedPath(".claude/commands/foo.md", PREFIXES), true);
	});
	test("segment-boundary enforcement — .github is NOT skipped under .git", () => {
		assert.equal(isSkippedPath(".github/workflow.md", PREFIXES), false);
	});
	test("unrelated path is not skipped", () => {
		assert.equal(isSkippedPath("work/active/note.md", PREFIXES), false);
	});
	test("empty prefix list never skips", () => {
		assert.equal(isSkippedPath(".git/foo", []), false);
	});
});
