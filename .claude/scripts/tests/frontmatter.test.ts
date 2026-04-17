/**
 * Unit tests for frontmatter module — skip rules and content validation.
 * Complements validate-write integration tests by testing the logic directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipFile, validateContent } from "../lib/frontmatter.ts";

describe("shouldSkipFile — skip rules", () => {
	test("skips non-markdown", () => {
		assert.equal(shouldSkipFile("/tmp/test.txt"), true);
	});
	test("skips empty path", () => {
		assert.equal(shouldSkipFile(""), true);
	});
	test("skips README.md", () => {
		assert.equal(shouldSkipFile("/some/path/README.md"), true);
	});
	test("skips translated READMEs", () => {
		for (const lang of ["ja", "ko", "zh-CN"]) {
			assert.equal(shouldSkipFile(`/some/path/README.${lang}.md`), true);
		}
	});
	test("skips CHANGELOG.md", () => {
		assert.equal(shouldSkipFile("/some/path/CHANGELOG.md"), true);
	});
	test("skips CLAUDE / AGENTS / GEMINI / CONTRIBUTING", () => {
		for (const f of ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "CONTRIBUTING.md"]) {
			assert.equal(shouldSkipFile(`/vault/${f}`), true);
		}
	});
	test("skips .claude/ paths", () => {
		assert.equal(shouldSkipFile("/vault/.claude/commands/foo.md"), true);
	});
	test("skips .codex/ paths", () => {
		assert.equal(shouldSkipFile("/vault/.codex/hooks.json.md"), true);
	});
	test("skips .gemini/ paths", () => {
		assert.equal(shouldSkipFile("/vault/.gemini/settings.md"), true);
	});
	test("skips .github/ paths (PR templates, workflow docs)", () => {
		assert.equal(shouldSkipFile("/repo/.github/pull_request_template.md"), true);
		assert.equal(shouldSkipFile("/repo/.github/ISSUE_TEMPLATE/bug.md"), true);
	});
	test("skips templates/", () => {
		assert.equal(shouldSkipFile("/vault/templates/Work Note.md"), true);
	});
	test("skips thinking/", () => {
		assert.equal(shouldSkipFile("/vault/thinking/draft.md"), true);
	});
	test("skips Windows backslash path with .claude\\", () => {
		assert.equal(shouldSkipFile("C:\\vault\\.claude\\commands\\foo.md"), true);
	});
	test("does NOT skip a regular vault note", () => {
		assert.equal(shouldSkipFile("/vault/work/active/project.md"), false);
	});
	test("does NOT skip a normal .obsidian-ish name (only the literal segment matters)", () => {
		// ".obsidianish.md" is a .md file not inside .obsidian/
		assert.equal(shouldSkipFile("/vault/work/active/.obsidianish.md"), false);
	});
});

describe("validateContent — frontmatter + wikilinks", () => {
	test("missing frontmatter on long note", () => {
		const warnings = validateContent("No frontmatter here\n" + "x".repeat(300));
		assert.ok(warnings.includes("Missing YAML frontmatter"));
	});

	test("missing tags", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("Missing `tags`")));
	});

	test("missing description", () => {
		const c =
			"---\ndate: 2026-04-05\ntags:\n  - test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("Missing `description`")));
	});

	test("missing date", () => {
		const c =
			"---\ndescription: test\ntags:\n  - test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("Missing `date`")));
	});

	test("no wikilinks on long note", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\n# Note\n" +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("No [[wikilinks]]")));
	});

	test("short note without wikilink is OK", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\nShort note.";
		assert.deepEqual(validateContent(c), []);
	});

	test("valid long note with wikilink produces no warnings", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: A valid test note\ntags:\n  - test\n---\n" +
			"# Note\n\nSome content with [[a wikilink]] and more text.\n" +
			"x".repeat(300);
		assert.deepEqual(validateContent(c), []);
	});

	test("tolerates 'tags :' with space (alternate YAML style)", () => {
		const c =
			"---\ndate : 2026-04-05\ndescription : test\ntags :\n  - test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		// All three field checks should accept the alternate spacing.
		assert.deepEqual(validateContent(c), []);
	});
});
