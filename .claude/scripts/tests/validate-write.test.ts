/**
 * Subprocess integration tests for validate-write.ts — skip rules,
 * frontmatter warnings, wikilink heuristic, robustness to bad input.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runScript as spawnHook, rmTemp } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../validate-write.ts",
);

let TMP_DIR = "";

before(() => {
	TMP_DIR = mkdtempSync(join(tmpdir(), "validate-write-test-"));
});

after(() => {
	rmTemp(TMP_DIR);
});

// The hook skips files outside the vault root; fixtures live in the OS
// tmpdir, so route the subprocess's vault root there — scoped to the spawn
// via envOverrides rather than mutating this process's env.
const runScript = (stdin: string | object | null) =>
	spawnHook(SCRIPT, stdin, { CLAUDE_PROJECT_DIR: TMP_DIR });

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
				// Filler is its own paragraph: on the next line it would be a
				// hard-wrapped one (#247).
				"# Note\n\nSome content with [[a wikilink]] and more text.\n\n" +
				"x".repeat(300),
			"g.md",
		);
		const { stdout, code } = runOn(path);
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
});

// --- Performance ---
describe("validate-write — performance", () => {
	test("1MB note validates in under 500ms", () => {
		const path = join(TMP_DIR, "big.md");
		const header =
			"---\ndate: 2026-04-17\ndescription: large note\ntags:\n  - test\n---\n[[link]]\n";
		const body = "lorem ipsum ".repeat(90_000);
		writeFileSync(path, header + body);

		const start = performance.now();
		const { code } = runScript({ tool_input: { file_path: path } });
		const elapsed = performance.now() - start;

		assert.equal(code, 0);
		assert.ok(
			elapsed < 1500,
			`validate-write took ${elapsed.toFixed(1)}ms on ~1MB note (budget 1500ms; includes subprocess spawn)`,
		);
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
		// Regression guard: empty stdin must short-circuit AND keep stderr
		// clean. Without the `--disable-warning=ExperimentalWarning` flag
		// in _helpers.ts, Node's type-stripping warning would leak here.
		const { code, stdout, stderr } = runScript(null);
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
	});
});

describe("phantom-edge policy result (#117)", () => {
	test("ticket-ID wikilinks emit the machine-readable finding next to the prose", () => {
		const path = makeMd(
			'---\ntags: [x]\ndescription: "d"\ndate: 2026-01-01\n---\n' +
				"[[Real Note]] and a phantom [[PROJ-1234]] edge.\n",
			"phantom.md",
		);
		const { stdout } = runOn(path);
		const parsed = JSON.parse(stdout) as {
			hookSpecificOutput: {
				additionalContext: string;
				policyResults?: Array<{ policy_id: string; classification: string }>;
			};
		};
		assert.match(parsed.hookSpecificOutput.additionalContext, /ticket-ID/);
		assert.ok(
			parsed.hookSpecificOutput.policyResults?.some(
				(r) =>
					r.policy_id === "phantom-edge" &&
					r.classification === "ticket-id-wikilink",
			),
		);
	});
});

describe("validate-write — required fields come from the manifest", () => {
	test("a work note missing `quarter` is flagged when the manifest requires it", () => {
		const vault = mkdtempSync(join(tmpdir(), "validate-write-manifest-"));
		try {
			mkdirSync(join(vault, "work", "active"), { recursive: true });
			writeFileSync(
				join(vault, "vault-manifest.json"),
				JSON.stringify({ frontmatter_required: { "work-note": ["status", "quarter"] } }),
			);
			const note = join(vault, "work", "active", "A.md");
			writeFileSync(note, "---\ndate: 2026-01-01\ndescription: d\ntags: [work-note]\nstatus: active\n---\nShort.");
			const { stdout, code } = spawnHook(SCRIPT, { tool_input: { file_path: note } }, { CLAUDE_PROJECT_DIR: vault });
			assert.equal(code, 0);
			assert.match(stdout, /Missing `quarter`/);
			assert.doesNotMatch(stdout, /Missing `status`/);
		} finally {
			rmTemp(vault);
		}
	});
});

describe("validate-write — under Gemini's AfterTool (#353)", () => {
	// Gemini's file tools are write_file and replace, and both take file_path
	// (gemini-cli tools/definitions/base-declarations.ts, as of 2026-10-13);
	// AfterTool reads hookSpecificOutput.additionalContext (hooks/types.ts).
	test("a write_file payload gets its warning back in an AfterTool envelope", () => {
		const path = makeMd("No frontmatter here\n" + "x".repeat(300), "gemini.md");
		const { stdout, code } = runScript({
			hook_event_name: "AfterTool",
			tool_name: "write_file",
			tool_input: { file_path: path, content: "" },
		});
		assert.equal(code, 0);
		const data = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
		assert.equal(data.hookSpecificOutput.hookEventName, "AfterTool");
		assert.match(data.hookSpecificOutput.additionalContext, /frontmatter/i);
	});
});

describe("validate-write — Codex apply_patch, whose payload names no file_path (#354)", () => {
	// openai/codex core/src/tools/handlers/apply_patch.rs: tool_input is
	// { command: <raw patch> }, and the request carries an absolute cwd
	// (hooks/src/events/post_tool_use.rs), as of 2026-10-13.
	const applyPatch = (patch: string, env: Record<string, string> = {}) =>
		spawnHook(
			SCRIPT,
			{ hook_event_name: "PostToolUse", tool_name: "apply_patch", cwd: TMP_DIR, tool_input: { command: patch } },
			{ CLAUDE_PROJECT_DIR: TMP_DIR, ...env },
		);
	const context = (stdout: string) =>
		(JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;

	test("an added note without frontmatter gets its warning, relative to the payload's cwd", () => {
		makeMd("No frontmatter here\n" + "x".repeat(300), "codex-added.md");
		const { stdout, code } = applyPatch("*** Begin Patch\n*** Add File: codex-added.md\n+No frontmatter here\n*** End Patch\n");
		assert.equal(code, 0);
		const out = context(stdout);
		assert.equal(out.hookEventName, "PostToolUse");
		assert.match(out.additionalContext, /codex-added\.md/);
	});

	test("every note a patch writes is validated, in one envelope", () => {
		makeMd("No frontmatter one\n" + "x".repeat(300), "codex-one.md");
		makeMd("No frontmatter two\n" + "x".repeat(300), "codex-two.md");
		const { stdout } = applyPatch(
			"*** Begin Patch\n*** Add File: codex-one.md\n+a\n*** Update File: codex-two.md\n@@\n+b\n*** End Patch\n",
		);
		const out = context(stdout);
		assert.match(out.additionalContext, /Vault hygiene warnings for `codex-one\.md`/);
		assert.match(out.additionalContext, /Vault hygiene warnings for `codex-two\.md`/);
	});

	test("a misplaced memory file in a patch is flagged, with its policy result", () => {
		const { stdout } = applyPatch(
			"*** Begin Patch\n*** Add File: /Users/foo/.claude/projects/-Users-foo-dev-bar/memory/feedback_x.md\n+x\n*** End Patch\n",
		);
		const out = JSON.parse(stdout) as {
			hookSpecificOutput: { additionalContext: string; policyResults?: Array<{ policy_id: string }> };
		};
		assert.match(out.hookSpecificOutput.additionalContext, /Memory location violation/);
		assert.deepEqual(out.hookSpecificOutput.policyResults?.map((p) => p.policy_id), ["memory-location"]);
	});

	test("a patch that writes a vault note triggers the refresh (the control for the case below)", () => {
		const sentinel = join(TMP_DIR, "md.sentinel");
		makeMd("---\ndate: 2026-10-13\n---\n" + "x".repeat(300), "codex-refresh.md");
		applyPatch("*** Begin Patch\n*** Add File: codex-refresh.md\n+x\n*** End Patch\n", { QMD_REFRESH_SENTINEL: sentinel });
		assert.ok(existsSync(sentinel), "the refresh touched its sentinel");
	});

	test("a patch touching only non-.md files warns nothing and triggers no refresh", () => {
		const sentinel = join(TMP_DIR, "nomd.sentinel");
		writeFileSync(join(TMP_DIR, "code.ts"), "export {};\n");
		const { stdout, code } = applyPatch("*** Begin Patch\n*** Add File: code.ts\n+export {};\n*** End Patch\n", {
			QMD_REFRESH_SENTINEL: sentinel,
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.ok(!existsSync(sentinel), "no refresh was triggered");
	});

	test("a patch touching only a note outside the vault warns nothing, as a single-file write does", () => {
		const outside = mkdtempSync(join(tmpdir(), "validate-write-outside-"));
		try {
			const note = join(outside, "elsewhere.md");
			writeFileSync(note, "No frontmatter here\n" + "x".repeat(300));
			const { stdout, code } = applyPatch(`*** Begin Patch\n*** Add File: ${note}\n+x\n*** End Patch\n`);
			assert.equal(code, 0);
			assert.equal(stdout, "");
		} finally {
			rmTemp(outside);
		}
	});
});

describe("validate-write — apply_patch review follow-ups (#354)", () => {
	const applyPatch = (patch: string, env: Record<string, string> = {}) =>
		spawnHook(
			SCRIPT,
			{ hook_event_name: "PostToolUse", tool_name: "apply_patch", cwd: TMP_DIR, tool_input: { command: patch } },
			{ CLAUDE_PROJECT_DIR: TMP_DIR, ...env },
		);

	test("a patch that only deletes a note still refreshes the index, which would otherwise serve it", () => {
		const sentinel = join(TMP_DIR, "delete.sentinel");
		const { stdout } = applyPatch("*** Begin Patch\n*** Delete File: gone.md\n*** End Patch\n", { QMD_REFRESH_SENTINEL: sentinel });
		assert.equal(stdout, "", "nothing to validate");
		assert.ok(existsSync(sentinel), "the refresh touched its sentinel");
	});

	test("three new notes joining one cluster give its hint once, not once per note", () => {
		const active = join(TMP_DIR, "work", "active");
		mkdirSync(active, { recursive: true });
		const fm = "---\ndate: 2026-10-13\ndescription: d\ntags: [work-note]\nquarter: Q4-2026\n---\n\nSee [[Home]].\n" + "x".repeat(300);
		// A cluster needs a root of at least 4 notes, its token in no more than
		// half of them (lib/active-hygiene.ts): 3 Pelican notes beside 3 others.
		for (const n of ["Pelican Plan.md", "Pelican Notes.md", "Pelican Risks.md", "Zebra Budget.md", "Otter Hiring.md", "Falcon Launch.md"]) {
			writeFileSync(join(active, n), fm);
		}
		const { stdout } = applyPatch(
			"*** Begin Patch\n*** Add File: work/active/Pelican Plan.md\n+x\n*** Add File: work/active/Pelican Notes.md\n+x\n*** Add File: work/active/Pelican Risks.md\n+x\n*** End Patch\n",
		);
		const out = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string; policyResults?: Array<{ policy_id: string }> } };
		assert.equal(out.hookSpecificOutput.additionalContext.split("loose sibling(s)").length - 1, 1, out.hookSpecificOutput.additionalContext);
		// The machine-readable results stay one per file: each names its own path.
		const clusterPaths = (out.hookSpecificOutput.policyResults as Array<{ policy_id: string; path: string }> | undefined)
			?.filter((p) => p.policy_id === "topic-cluster")
			.map((p) => p.path)
			.sort();
		assert.deepEqual(clusterPaths, ["work/active/Pelican Notes.md", "work/active/Pelican Plan.md", "work/active/Pelican Risks.md"]);
	});
});
