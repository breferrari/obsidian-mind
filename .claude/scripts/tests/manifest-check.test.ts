/**
 * Unit tests for manifest-check pure functions: globToRegex and isCovered.
 * The filesystem walk and warning emission in the entry point are exercised
 * live by the workflow; these lock the matching grammar.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	globToRegex,
	isCovered,
	toPosix,
	listTopLevelFiles,
} from "../../../.github/scripts/manifest-check.ts";

import { rmTemp } from "./_helpers.ts";

/** The real manifest's shape, in miniature. */
const GLOBS = ["CLAUDE.md", ".claude/**", "templates/**", "brain/Skills.md"];

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

	// The manifest globs are POSIX, but the directory walk built its paths with
	// `join`, which emits the PLATFORM separator. On Windows that made every
	// infrastructure file look uncovered, so the check failed against a clean
	// tree for every Windows contributor, while CI runs Linux and saw nothing.
	//
	// Asserted with a literal backslash rather than by running the walk, so the
	// guard can fail on ANY platform. A test that only goes red on Windows is a
	// test no CI machine will ever run.
	test("a windows-separated path is covered by a posix glob", () => {
		assert.equal(isCovered(".claude\\commands\\om-tidy.md", GLOBS), true);
		assert.equal(isCovered("templates\\Work Note.md", GLOBS), true);
	});

	test("normalizing separators does not make an uncovered path covered", () => {
		assert.equal(isCovered("work\\active\\project.md", GLOBS), false);
	});
});

describe("toPosix", () => {
	test("converts backslashes and leaves posix paths alone", () => {
		assert.equal(toPosix(".claude\\agents\\x.md"), ".claude/agents/x.md");
		assert.equal(toPosix(".claude/agents/x.md"), ".claude/agents/x.md");
	});

	test("a nullish path does not throw its way into the walk", () => {
		assert.equal(toPosix(undefined as unknown as string), "");
	});
});

// The seam the bug lived in. The walk is the one place a platform separator
// enters, and this file's header used to say it was "exercised live by the
// workflow" — which only ever runs Linux.
describe("listTopLevelFiles", () => {
	// Driven against a real directory rather than the repo's own, so the test
	// does not depend on the cwd the runner happens to use.
	test("emits posix-separated paths its own globs can match", () => {
		const dir = mkdtempSync(join(tmpdir(), "mc-"));
		try {
			writeFileSync(join(dir, "alpha.md"), "x", "utf8");
			writeFileSync(join(dir, "beta.md"), "x", "utf8");
			writeFileSync(join(dir, "ignored.txt"), "x", "utf8");

			const found = listTopLevelFiles(dir, [".md"]);
			assert.equal(found.length, 2, "extension filter still applies");
			for (const p of found) {
				assert.ok(!p.includes("\\"), `walk emitted a platform separator: ${p}`);
			}
			// The property that actually matters: what the walk emits is a shape
			// the manifest globs can match. On Windows the old walk failed this.
			const globs = [`${toPosix(dir)}/**`];
			for (const p of found) {
				assert.ok(isCovered(p, globs), `walk emitted a path its own glob cannot match: ${p}`);
			}
		} finally {
			rmTemp(dir);
		}
	});

	test("a missing directory is empty, not a throw", () => {
		assert.deepEqual(listTopLevelFiles("does/not/exist", [".md"]), []);
	});
});
