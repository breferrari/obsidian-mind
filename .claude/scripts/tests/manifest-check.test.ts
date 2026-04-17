/**
 * Unit tests for manifest-check pure functions: globToRegex and isCovered.
 * The filesystem walk and warning emission in the entry point are exercised
 * live by the workflow; these lock the matching grammar.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	globToRegex,
	isCovered,
} from "../../../.github/scripts/manifest-check.ts";

describe("globToRegex", () => {
	test("exact string (no wildcards)", () => {
		const r = globToRegex("CLAUDE.md");
		assert.ok(r.test("CLAUDE.md"));
		// dots must be escaped — a slash-separator should not match a dot
		assert.ok(!r.test("CLAUDExmd"));
	});

	test("double-star matches any depth", () => {
		const r = globToRegex(".claude/**");
		assert.ok(r.test(".claude/commands/foo.md"));
		assert.ok(r.test(".claude/scripts/lib/hook-io.ts"));
		assert.ok(r.test(".claude/x"));
		// bare prefix with no suffix should NOT match (preserves the sed-chain's behaviour)
		assert.ok(!r.test(".claude"));
	});

	test("single-star is one path segment", () => {
		const r = globToRegex(".claude/commands/*.md");
		assert.ok(r.test(".claude/commands/foo.md"));
		assert.ok(r.test(".claude/commands/a-b-c.md"));
		// must not cross a slash
		assert.ok(!r.test(".claude/commands/sub/foo.md"));
		// must match the expected extension
		assert.ok(!r.test(".claude/commands/foo.ts"));
	});

	test("double-star in the middle", () => {
		const r = globToRegex("a/**/b.md");
		assert.ok(r.test("a/x/b.md"));
		assert.ok(r.test("a/x/y/b.md"));
	});

	test("escapes regex metacharacters in literal segments", () => {
		const r = globToRegex("brain/Skills.md");
		assert.ok(r.test("brain/Skills.md"));
		// without escaping, . would match any character and 'Skillsxmd' would pass
		assert.ok(!r.test("brain/Skillsxmd"));
	});

	test("anchors with ^ and $ (no prefix/suffix bleed)", () => {
		const r = globToRegex("CLAUDE.md");
		assert.ok(!r.test("xCLAUDE.md"));
		assert.ok(!r.test("CLAUDE.mdx"));
	});

	test("plus and other regex specials are escaped", () => {
		const r = globToRegex("a+b.md");
		assert.ok(r.test("a+b.md"));
		assert.ok(!r.test("ab.md"));
	});
});

describe("isCovered", () => {
	const GLOBS = [
		"CLAUDE.md",
		".claude/**",
		"templates/**",
		"brain/Skills.md",
	];

	test("exact-string glob matches the same string", () => {
		assert.equal(isCovered("CLAUDE.md", GLOBS), true);
		assert.equal(isCovered("brain/Skills.md", GLOBS), true);
	});

	test("wildcard glob matches any descendant", () => {
		assert.equal(isCovered(".claude/scripts/foo.ts", GLOBS), true);
		assert.equal(isCovered("templates/Work Note.md", GLOBS), true);
	});

	test("path outside any glob is not covered", () => {
		assert.equal(isCovered("work/active/project.md", GLOBS), false);
		assert.equal(isCovered("README.md", GLOBS), false);
	});

	test("empty glob list never covers anything", () => {
		assert.equal(isCovered("anything", []), false);
	});

	test("exact-string glob does NOT match prefix variants", () => {
		assert.equal(isCovered("CLAUDE.md.bak", GLOBS), false);
		assert.equal(isCovered("x/CLAUDE.md", GLOBS), false);
	});
});
