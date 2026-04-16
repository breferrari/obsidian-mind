/**
 * Subprocess integration tests for validate-write.ts.
 * 1-1 parity with TestValidateWriteIntegration from Python test_hooks.py.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../validate-write.ts");

let TMP_DIR = "";

before(() => {
	TMP_DIR = mkdtempSync(join(tmpdir(), "validate-write-test-"));
});

after(() => {
	if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true });
});

function runScript(stdin: string | object | null): {
	stdout: string;
	stderr: string;
	code: number;
} {
	const input =
		stdin === null
			? ""
			: typeof stdin === "string"
				? stdin
				: JSON.stringify(stdin);
	const proc = spawnSync(
		process.execPath,
		["--experimental-strip-types", SCRIPT],
		{ input, encoding: "utf-8", timeout: 10000 },
	);
	return {
		stdout: proc.stdout ?? "",
		stderr: proc.stderr ?? "",
		code: proc.status ?? -1,
	};
}

function makeMd(content: string, name = "test.md"): string {
	const path = join(TMP_DIR, name);
	writeFileSync(path, content, { encoding: "utf-8" });
	return path;
}

function runOn(filePath: string) {
	return runScript({ tool_input: { file_path: filePath } });
}

// --- Skip rules ---
describe("validate-write — skip rules (silent exit, no stdout)", () => {
	test("skips non-markdown", () => {
		const { stdout, code } = runOn("/tmp/test.txt");
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
	test("skips README.md", () => {
		const { stdout, code } = runOn("/some/path/README.md");
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
	test("skips translated READMEs", () => {
		for (const lang of ["ja", "ko", "zh-CN"]) {
			const { stdout, code } = runOn(`/some/path/README.${lang}.md`);
			assert.equal(code, 0);
			assert.equal(stdout.trim(), "");
		}
	});
	test("skips CHANGELOG.md", () => {
		const { stdout, code } = runOn("/some/path/CHANGELOG.md");
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
	test("skips .claude/ dir", () => {
		const { stdout, code } = runOn("/vault/.claude/commands/foo.md");
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
	test("skips templates/", () => {
		const { stdout, code } = runOn("/vault/templates/Work Note.md");
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
	test("skips thinking/", () => {
		const { stdout, code } = runOn("/vault/thinking/draft.md");
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
	test("skips Windows backslash path", () => {
		const { stdout, code } = runOn("C:\\vault\\.claude\\commands\\foo.md");
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
});

// --- Frontmatter validation ---
describe("validate-write — frontmatter validation", () => {
	test("missing frontmatter", () => {
		const path = makeMd("No frontmatter here\n" + "x".repeat(300), "a.md");
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		const data = JSON.parse(stdout) as {
			hookSpecificOutput: {
				hookEventName: string;
				additionalContext: string;
			};
		};
		assert.equal(data.hookSpecificOutput.hookEventName, "PostToolUse");
		assert.ok(
			data.hookSpecificOutput.additionalContext.includes(
				"Missing YAML frontmatter",
			),
		);
	});

	test("missing tags", () => {
		const path = makeMd(
			"---\ndate: 2026-04-05\ndescription: test\n---\n# Note\n[[Link]] " +
				"x".repeat(300),
			"b.md",
		);
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		assert.ok(stdout.includes("Missing `tags`"));
	});

	test("missing description", () => {
		const path = makeMd(
			"---\ndate: 2026-04-05\ntags:\n  - test\n---\n# Note\n[[Link]] " +
				"x".repeat(300),
			"c.md",
		);
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		assert.ok(stdout.includes("Missing `description`"));
	});

	test("missing date", () => {
		const path = makeMd(
			"---\ndescription: test\ntags:\n  - test\n---\n# Note\n[[Link]] " +
				"x".repeat(300),
			"d.md",
		);
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		assert.ok(stdout.includes("Missing `date`"));
	});
});

// --- Wikilink validation ---
describe("validate-write — wikilink validation", () => {
	test("no wikilinks in long note", () => {
		const path = makeMd(
			"---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\n# Note\n" +
				"x".repeat(300),
			"e.md",
		);
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		assert.ok(stdout.includes("No [[wikilinks]]"));
	});

	test("short note without wikilink is OK", () => {
		const path = makeMd(
			"---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\nShort note.",
			"f.md",
		);
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
});

// --- Valid note ---
describe("validate-write — valid note produces no warnings", () => {
	test("fully-formed note", () => {
		const path = makeMd(
			"---\ndate: 2026-04-05\ndescription: A valid test note\ntags:\n  - test\n---\n" +
				"# Note\n\nSome content with [[a wikilink]] and more text.\n" +
				"x".repeat(300),
			"g.md",
		);
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
});

// --- Type safety ---
describe("validate-write — robustness to bad input", () => {
	test("null tool_input", () => {
		const { code } = runScript({ tool_input: null });
		assert.equal(code, 0);
	});
	test("non-string file_path", () => {
		const { code } = runScript({ tool_input: { file_path: 123 } });
		assert.equal(code, 0);
	});
	test("invalid JSON", () => {
		const { code } = runScript("not json");
		assert.equal(code, 0);
	});
	test("nonexistent file", () => {
		const { code } = runOn("/nonexistent/path/note.md");
		assert.equal(code, 0);
	});
	test("empty object", () => {
		const { code } = runScript({});
		assert.equal(code, 0);
	});
	test("empty stdin", () => {
		const { code } = runScript(null);
		assert.equal(code, 0);
	});
});
