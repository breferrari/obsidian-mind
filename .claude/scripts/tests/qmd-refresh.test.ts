/**
 * Unit tests for lib/qmd-refresh.ts pure helpers.
 *
 * Locks the predicates and composition logic the PostToolUse hook, the
 * Stop hook, and the detached worker all depend on. Pure tests run
 * identically on every OS in the CI matrix, so argv drift (wrong order,
 * missing `--index`, dropped subcommand) fails here before any live qmd
 * invocation would notice on macOS/Linux only.
 *
 * Subprocess integration coverage for the hook entry script lives in
 * `qmd-refresh.integration.test.ts` — both are exercised by
 * `npm test` in the hook-scripts package.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sep as pathSep } from "node:path";
import {
	composeWorkerInvocations,
	isDebounced,
	resolveVaultRoot,
	shouldRefreshForPath,
} from "../lib/qmd-refresh.ts";

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

describe("resolveVaultRoot", () => {
	test("strips the .claude/scripts suffix from an absolute input", () => {
		// path.resolve uses the platform-native separator, so we assemble
		// the expected result with path.sep to stay cross-platform.
		const result = resolveVaultRoot(
			`${pathSep}Users${pathSep}me${pathSep}vault${pathSep}.claude${pathSep}scripts`,
		);
		const expected = `${pathSep}Users${pathSep}me${pathSep}vault`;
		assert.equal(result, expected);
	});
	test("handles a trailing separator gracefully", () => {
		const result = resolveVaultRoot(
			`${pathSep}vault${pathSep}.claude${pathSep}scripts${pathSep}`,
		);
		assert.equal(result, `${pathSep}vault`);
	});
	test("always returns an absolute path (path.resolve guarantees this)", () => {
		// path.resolve always returns an absolute path; a relative input
		// is resolved against cwd. We only assert absoluteness here — the
		// suffix-stripping semantics are locked by the absolute-input
		// test above.
		const result = resolveVaultRoot("a/b/.claude/scripts");
		// Unix absolute: starts with "/". Windows absolute: drive letter
		// like "C:\\" or a UNC "\\\\".
		const isAbsolute = /^(?:[A-Za-z]:|\\\\)/.test(result) || result.startsWith("/");
		assert.ok(isAbsolute, `expected absolute path, got: ${result}`);
	});
});

describe("composeWorkerInvocations", () => {
	test("returns update then embed in that order", () => {
		const invs = composeWorkerInvocations(
			"obsidian-mind",
			"/opt/qmd/qmd.js",
		);
		assert.equal(invs.length, 2);
		assert.ok(invs[0]?.args.includes("update"));
		assert.ok(invs[1]?.args.includes("embed"));
	});

	test("threads --index <name> through both invocations when set", () => {
		const invs = composeWorkerInvocations("vault-2", "/opt/qmd/qmd.js");
		for (const inv of invs) {
			assert.deepEqual(
				inv.args.slice(0, 3),
				["/opt/qmd/qmd.js", "--index", "vault-2"],
				`expected --index vault-2 to precede the subcommand in ${inv.args.join(" ")}`,
			);
		}
		assert.equal(invs[0]?.args.at(-1), "update");
		assert.equal(invs[1]?.args.at(-1), "embed");
	});

	test("omits --index when qmdIndex is null (legacy / pre-named fork)", () => {
		const invs = composeWorkerInvocations(null, "/opt/qmd/qmd.js");
		for (const inv of invs) {
			assert.equal(inv.args.includes("--index"), false);
		}
		assert.deepEqual(invs[0]?.args, ["/opt/qmd/qmd.js", "update"]);
		assert.deepEqual(invs[1]?.args, ["/opt/qmd/qmd.js", "embed"]);
	});

	test("both invocations go through process.execPath when entry resolves", () => {
		const invs = composeWorkerInvocations("v", "/opt/qmd/qmd.js");
		for (const inv of invs) {
			assert.equal(inv.cmd, process.execPath);
			assert.equal(inv.shell, false);
		}
	});

	test("falls back to bare `qmd` with shell: true when entry is null", () => {
		const invs = composeWorkerInvocations("v", null);
		for (const inv of invs) {
			assert.equal(inv.cmd, "qmd");
			assert.equal(inv.shell, true);
		}
	});

	test("fallback preserves --index threading", () => {
		const invs = composeWorkerInvocations("vault-2", null);
		assert.deepEqual(invs[0]?.args, ["--index", "vault-2", "update"]);
		assert.deepEqual(invs[1]?.args, ["--index", "vault-2", "embed"]);
	});

	test("embed gets a longer budget than update (model download slot)", () => {
		const [update, embed] = composeWorkerInvocations("v", "/opt/qmd.js");
		// Update runs incrementally in seconds; embed may download a
		// model on first run. Asserting the ordering locks the contract
		// that embed isn't accidentally given the tighter budget.
		assert.ok(
			update && embed && embed.timeoutMs > update.timeoutMs,
			`embed budget (${embed?.timeoutMs}) must exceed update budget (${update?.timeoutMs})`,
		);
	});
});
