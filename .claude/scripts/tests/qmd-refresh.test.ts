/**
 * Unit tests for lib/qmd-refresh.ts pure helpers. Locks the path-skip
 * and debounce predicates so the PostToolUse and Stop hooks stay in
 * exact agreement — both consume these without fs side effects.
 *
 * Integration tests for the entry scripts (qmd-refresh.ts and the Stop
 * hook extension) are deliberately omitted: both spawn detached
 * children whose timing is unreliable under `node --test`, and their
 * surface is already covered by the pure predicates here plus a live
 * smoke run on dev machines.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isDebounced, shouldRefreshForPath } from "../lib/qmd-refresh.ts";

describe("shouldRefreshForPath — accepts vault markdown", () => {
	test("accepts a relative vault note", () => {
		assert.equal(shouldRefreshForPath("work/active/project.md"), true);
	});
	test("accepts an absolute Unix vault note", () => {
		assert.equal(
			shouldRefreshForPath("/Users/me/vault/work/active/project.md"),
			true,
		);
	});
	test("accepts an absolute Windows vault note", () => {
		assert.equal(
			shouldRefreshForPath("C:\\Users\\me\\vault\\work\\active\\project.md"),
			true,
		);
	});
	test("accepts a Windows UNC path", () => {
		assert.equal(
			shouldRefreshForPath("\\\\server\\share\\vault\\note.md"),
			true,
		);
	});
	test("accepts uppercase .MD extension", () => {
		assert.equal(shouldRefreshForPath("work/active/project.MD"), true);
	});
	test("accepts brain/, org/, perf/ paths (vault content roots)", () => {
		assert.equal(shouldRefreshForPath("brain/Patterns.md"), true);
		assert.equal(shouldRefreshForPath("org/people/Alice.md"), true);
		assert.equal(shouldRefreshForPath("perf/Brag Doc.md"), true);
	});
	test("accepts paths with spaces (Obsidian-style filenames)", () => {
		assert.equal(shouldRefreshForPath("work/1-1/Jane Smith 2026-04-05.md"), true);
	});
});

describe("shouldRefreshForPath — rejects non-markdown writes", () => {
	test("rejects empty path", () => {
		assert.equal(shouldRefreshForPath(""), false);
	});
	test("rejects non-string (defensive)", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		assert.equal(shouldRefreshForPath(undefined as any), false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		assert.equal(shouldRefreshForPath(null as any), false);
	});
	test("rejects .txt, .json, .ts, .yaml", () => {
		assert.equal(shouldRefreshForPath("work/note.txt"), false);
		assert.equal(shouldRefreshForPath("vault-manifest.json"), false);
		assert.equal(shouldRefreshForPath(".claude/scripts/foo.ts"), false);
		assert.equal(shouldRefreshForPath("config.yaml"), false);
	});
	test("rejects .mdx (not qmd's `**/*.md` pattern)", () => {
		assert.equal(shouldRefreshForPath("page.mdx"), false);
	});
	test("rejects extensionless paths", () => {
		assert.equal(shouldRefreshForPath("Makefile"), false);
		assert.equal(shouldRefreshForPath("LICENSE"), false);
	});
});

describe("shouldRefreshForPath — rejects skip-segment paths", () => {
	test("rejects .git internals", () => {
		assert.equal(shouldRefreshForPath(".git/COMMIT_EDITMSG.md"), false);
		assert.equal(
			shouldRefreshForPath("/Users/me/vault/.git/info/exclude.md"),
			false,
		);
	});
	test("rejects .obsidian config", () => {
		assert.equal(shouldRefreshForPath(".obsidian/workspace.md"), false);
		assert.equal(
			shouldRefreshForPath("/vault/.obsidian/plugins/foo/README.md"),
			false,
		);
	});
	test("rejects node_modules trees", () => {
		assert.equal(
			shouldRefreshForPath(".claude/scripts/node_modules/foo/README.md"),
			false,
		);
		assert.equal(
			shouldRefreshForPath("/vault/node_modules/pkg/CHANGELOG.md"),
			false,
		);
	});
	test("rejects Windows-form skip paths (backslash normalization)", () => {
		assert.equal(
			shouldRefreshForPath("C:\\vault\\.git\\info\\note.md"),
			false,
		);
		assert.equal(
			shouldRefreshForPath("C:\\vault\\.obsidian\\workspace.md"),
			false,
		);
		assert.equal(
			shouldRefreshForPath(
				"C:\\vault\\.claude\\scripts\\node_modules\\pkg\\README.md",
			),
			false,
		);
	});
	test("segment-boundary enforcement — .github does NOT match .git", () => {
		assert.equal(
			shouldRefreshForPath(".github/ISSUE_TEMPLATE.md"),
			true,
		);
	});
	test("segment-boundary enforcement — node_modules_backup does NOT match", () => {
		assert.equal(
			shouldRefreshForPath("archive/node_modules_backup_docs.md"),
			true,
		);
	});
});

describe("isDebounced — fresh sentinel", () => {
	test("returns true when elapsed < debounce window", () => {
		assert.equal(isDebounced(1_000, 1_500, 30_000), true);
	});
	test("returns true at the very start of the window (0ms elapsed)", () => {
		assert.equal(isDebounced(1_000, 1_000, 30_000), true);
	});
	test("returns false exactly at the debounce boundary", () => {
		assert.equal(isDebounced(1_000, 31_000, 30_000), false);
	});
	test("returns false when elapsed exceeds window", () => {
		assert.equal(isDebounced(1_000, 60_000, 30_000), false);
	});
});

describe("isDebounced — absent or invalid sentinel", () => {
	test("returns false when sentinel doesn't exist (null mtime)", () => {
		assert.equal(isDebounced(null, 1_000, 30_000), false);
	});
	test("returns false on negative elapsed (clock skew backwards)", () => {
		// Safer failure mode: wall-clock going backwards should not wedge
		// the refresh indefinitely.
		assert.equal(isDebounced(10_000, 5_000, 30_000), false);
	});
	test("returns false when debounce window is zero", () => {
		assert.equal(isDebounced(1_000, 1_000, 0), false);
	});
});
