/**
 * Unit tests for lib/qmd-ignore — ignore-propagation helpers. The functions
 * are pure (readObsidianIgnore, translateToGlob, upsertIgnoreInYaml) plus one
 * file-IO wrapper (writeQmdIgnore) that we exercise against tmp files.
 *
 * The bootstrap itself is an integration seam (spawns qmd subprocesses) and is
 * covered by the manual re-run during release; these tests lock the contracts
 * that make the seam correct.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	readObsidianIgnore,
	translateToGlob,
	upsertIgnoreInYaml,
	writeQmdIgnore,
	qmdConfigPath,
} from "../lib/qmd-ignore.ts";

const YAML_BASE = `collections:
  obsidian-mind:
    path: /Users/dev/obsidian-mind
    pattern: "**/*.md"
    context:
      "": "Engineer's work vault"
`;

const YAML_WITH_IGNORE = `collections:
  obsidian-mind:
    path: /Users/dev/obsidian-mind
    pattern: "**/*.md"
    ignore:
      - "ARCHITECTURE.md"
      - "CHANGELOG.md"
    context:
      "": "Engineer's work vault"
`;

describe("translateToGlob", () => {
	test("plain filename passes through unchanged", () => {
		assert.equal(translateToGlob("ARCHITECTURE.md"), "ARCHITECTURE.md");
	});

	test("glob with wildcard passes through unchanged", () => {
		assert.equal(translateToGlob("**/draft-*.md"), "**/draft-*.md");
	});

	test("trailing-slash folder expands to recursive glob", () => {
		assert.equal(translateToGlob("work/"), "work/**");
		assert.equal(translateToGlob("perf/brag/"), "perf/brag/**");
	});

	test("regex pattern (/.../) returns null to be dropped by caller", () => {
		assert.equal(translateToGlob("/README\\..*\\.md/"), null);
		assert.equal(translateToGlob("/draft/"), null);
	});

	test("single '/' is not treated as regex", () => {
		// A one-character '/' at start + end is the same character; guarding
		// on length avoids false-positive regex detection.
		assert.equal(translateToGlob("/"), "/**");
	});

	test("empty string passes through unchanged", () => {
		assert.equal(translateToGlob(""), "");
	});
});

describe("readObsidianIgnore", () => {
	const tmp = mkdtempSync(join(tmpdir(), "qmd-bootstrap-obsidian-"));

	test.after(() => rmSync(tmp, { recursive: true, force: true }));

	test("missing file returns empty array", () => {
		assert.deepEqual(readObsidianIgnore(join(tmp, "does-not-exist.json")), []);
	});

	test("valid file returns the patterns array", () => {
		const path = join(tmp, "valid.json");
		writeFileSync(
			path,
			JSON.stringify({ userIgnoreFilters: ["ARCHITECTURE.md", "foo/"] }),
		);
		assert.deepEqual(readObsidianIgnore(path), ["ARCHITECTURE.md", "foo/"]);
	});

	test("missing userIgnoreFilters field returns empty array", () => {
		const path = join(tmp, "empty.json");
		writeFileSync(path, JSON.stringify({ otherField: "x" }));
		assert.deepEqual(readObsidianIgnore(path), []);
	});

	test("userIgnoreFilters not an array returns empty array", () => {
		const path = join(tmp, "not-array.json");
		writeFileSync(path, JSON.stringify({ userIgnoreFilters: "not an array" }));
		assert.deepEqual(readObsidianIgnore(path), []);
	});

	test("non-string array entries are dropped", () => {
		const path = join(tmp, "mixed.json");
		writeFileSync(
			path,
			JSON.stringify({ userIgnoreFilters: ["ok.md", 42, null, "also-ok.md"] }),
		);
		assert.deepEqual(readObsidianIgnore(path), ["ok.md", "also-ok.md"]);
	});

	test("malformed JSON returns empty array (no throw)", () => {
		const path = join(tmp, "broken.json");
		writeFileSync(path, "{not valid json");
		assert.deepEqual(readObsidianIgnore(path), []);
	});
});

describe("upsertIgnoreInYaml — pure transform", () => {
	test("injects ignore block after pattern line in clean YAML", () => {
		const next = upsertIgnoreInYaml(YAML_BASE, "obsidian-mind", [
			"ARCHITECTURE.md",
		]);
		assert.ok(next !== null);
		assert.ok(next.includes('    ignore:\n      - "ARCHITECTURE.md"\n'));
		// Block sits between pattern and context — preserves schema order.
		const patternIdx = next.indexOf('    pattern: "**/*.md"');
		const ignoreIdx = next.indexOf("    ignore:");
		const contextIdx = next.indexOf("    context:");
		assert.ok(patternIdx < ignoreIdx && ignoreIdx < contextIdx);
	});

	test("re-running with the same patterns is idempotent", () => {
		const once = upsertIgnoreInYaml(YAML_BASE, "obsidian-mind", [
			"ARCHITECTURE.md",
		]);
		assert.ok(once !== null);
		const twice = upsertIgnoreInYaml(once, "obsidian-mind", [
			"ARCHITECTURE.md",
		]);
		assert.equal(twice, once);
	});

	test("re-running with different patterns replaces the block", () => {
		const first = upsertIgnoreInYaml(YAML_BASE, "obsidian-mind", [
			"ARCHITECTURE.md",
		]);
		assert.ok(first !== null);
		const second = upsertIgnoreInYaml(first, "obsidian-mind", [
			"CHANGELOG.md",
		]);
		assert.ok(second !== null);
		assert.ok(second.includes('      - "CHANGELOG.md"'));
		assert.ok(!second.includes('      - "ARCHITECTURE.md"'));
		// Only one ignore: block in the file.
		assert.equal(second.match(/^    ignore:$/gm)?.length, 1);
	});

	test("empty patterns strips existing ignore block", () => {
		const next = upsertIgnoreInYaml(YAML_WITH_IGNORE, "obsidian-mind", []);
		assert.ok(next !== null);
		assert.ok(!next.includes("    ignore:"));
		// Preserves the other fields intact.
		assert.ok(next.includes('    pattern: "**/*.md"'));
		assert.ok(next.includes("    context:"));
	});

	test("unknown collection returns null (distinct from 'no change needed')", () => {
		assert.equal(
			upsertIgnoreInYaml(YAML_BASE, "other-name", ["ARCHITECTURE.md"]),
			null,
		);
	});

	test("patterns with special regex chars in name are safely quoted", () => {
		// Backslashes and brackets inside the pattern must not break the
		// surrounding regex used to locate the collection header.
		const next = upsertIgnoreInYaml(YAML_BASE, "obsidian-mind", [
			"path[with].weird*chars.md",
		]);
		assert.ok(next !== null);
		assert.ok(next.includes('      - "path[with].weird*chars.md"'));
	});

	test("multi-collection YAML only targets the named collection", () => {
		const multi = `collections:
  other-vault:
    path: /other
    pattern: "**/*.md"
    context:
      "": "other"
  obsidian-mind:
    path: /mine
    pattern: "**/*.md"
    context:
      "": "mine"
`;
		const next = upsertIgnoreInYaml(multi, "obsidian-mind", [
			"ARCHITECTURE.md",
		]);
		assert.ok(next !== null);
		// Only one ignore block added.
		assert.equal(next.match(/^    ignore:$/gm)?.length, 1);
		// The block is inside obsidian-mind, not other-vault.
		const obsidianMindStart = next.indexOf("  obsidian-mind:");
		const ignoreIdx = next.indexOf("    ignore:");
		assert.ok(ignoreIdx > obsidianMindStart);
	});

	test("preserves other collections' existing ignore blocks when editing one", () => {
		// Regression test: a previous version used a global IGNORE_BLOCK_RE
		// strip that would silently delete other-vault's ignore entries on
		// every bootstrap run against a multi-collection file.
		const multi = `collections:
  other-vault:
    path: /other
    pattern: "**/*.md"
    ignore:
      - "SECRETS.md"
      - "private/"
    context:
      "": "other"
  obsidian-mind:
    path: /mine
    pattern: "**/*.md"
    context:
      "": "mine"
`;
		const next = upsertIgnoreInYaml(multi, "obsidian-mind", [
			"ARCHITECTURE.md",
		]);
		assert.ok(next !== null);
		// other-vault's ignore list is untouched.
		assert.ok(next.includes('      - "SECRETS.md"'));
		assert.ok(next.includes('      - "private/"'));
		// obsidian-mind got its own ignore block.
		assert.ok(next.includes('      - "ARCHITECTURE.md"'));
		// Exactly two ignore blocks in the file (one per collection).
		assert.equal(next.match(/^    ignore:$/gm)?.length, 2);
	});

	test("empty patterns strips only the target collection's ignore block", () => {
		const multi = `collections:
  other-vault:
    path: /other
    pattern: "**/*.md"
    ignore:
      - "SECRETS.md"
    context:
      "": "other"
  obsidian-mind:
    path: /mine
    pattern: "**/*.md"
    ignore:
      - "ARCHITECTURE.md"
    context:
      "": "mine"
`;
		const next = upsertIgnoreInYaml(multi, "obsidian-mind", []);
		assert.ok(next !== null);
		// other-vault's ignore survives.
		assert.ok(next.includes('      - "SECRETS.md"'));
		// obsidian-mind's ignore was stripped.
		assert.ok(!next.includes('      - "ARCHITECTURE.md"'));
		// Exactly one ignore block remains.
		assert.equal(next.match(/^    ignore:$/gm)?.length, 1);
	});
});

describe("writeQmdIgnore — file IO wrapper", () => {
	const tmp = mkdtempSync(join(tmpdir(), "qmd-bootstrap-yaml-"));

	test.after(() => rmSync(tmp, { recursive: true, force: true }));

	test("writes the transformed YAML when patterns are non-empty", () => {
		const path = join(tmp, "write.yml");
		writeFileSync(path, YAML_BASE);
		const ok = writeQmdIgnore(path, "obsidian-mind", ["ARCHITECTURE.md"]);
		assert.equal(ok, true);
		const after = readFileSync(path, "utf-8");
		assert.ok(after.includes('    ignore:\n      - "ARCHITECTURE.md"\n'));
	});

	test("is idempotent: second call with same patterns doesn't change bytes", () => {
		const path = join(tmp, "idempotent.yml");
		writeFileSync(path, YAML_BASE);
		writeQmdIgnore(path, "obsidian-mind", ["ARCHITECTURE.md"]);
		const first = readFileSync(path, "utf-8");
		writeQmdIgnore(path, "obsidian-mind", ["ARCHITECTURE.md"]);
		const second = readFileSync(path, "utf-8");
		assert.equal(second, first);
	});

	test("empty patterns on a file with existing block strips it", () => {
		const path = join(tmp, "strip.yml");
		writeFileSync(path, YAML_WITH_IGNORE);
		const ok = writeQmdIgnore(path, "obsidian-mind", []);
		assert.equal(ok, true);
		const after = readFileSync(path, "utf-8");
		assert.ok(!after.includes("    ignore:"));
	});

	test("empty patterns on a file with no block is a no-op", () => {
		const path = join(tmp, "noop.yml");
		writeFileSync(path, YAML_BASE);
		const ok = writeQmdIgnore(path, "obsidian-mind", []);
		assert.equal(ok, true);
		assert.equal(readFileSync(path, "utf-8"), YAML_BASE);
	});

	test("missing file returns false (no throw)", () => {
		const ok = writeQmdIgnore(
			join(tmp, "does-not-exist.yml"),
			"obsidian-mind",
			["ARCHITECTURE.md"],
		);
		assert.equal(ok, false);
	});

	test("unknown collection returns false and leaves file unchanged", () => {
		const path = join(tmp, "unknown.yml");
		writeFileSync(path, YAML_BASE);
		const ok = writeQmdIgnore(path, "not-a-collection", ["ARCHITECTURE.md"]);
		assert.equal(ok, false);
		assert.equal(readFileSync(path, "utf-8"), YAML_BASE);
	});
});

describe("qmdConfigPath", () => {
	test("composes path from homedir, .config/qmd, and index name", () => {
		const p = qmdConfigPath("obsidian-mind");
		// Normalize separators so the assertion works on both POSIX (`/`) and
		// Windows (`\`). path.join picks the platform-native separator.
		const normalized = p.replaceAll("\\", "/");
		assert.ok(normalized.endsWith("/.config/qmd/obsidian-mind.yml"));
		// Absolute path, not relative.
		assert.ok(p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p));
	});
});
