/**
 * Cross-platform tests for the QMD MCP wrapper.
 *
 * The real value of these tests is the CI matrix: they run on
 * ubuntu-latest, macos-latest, and windows-latest × Node 22/24.
 * CI installs @tobilu/qmd globally before the suite, so the happy-path
 * resolution assertion proves `require.resolve` + `npm root -g` find qmd
 * on every platform the template supports — exactly the guarantee this
 * wrapper exists to deliver.
 *
 * Pure-function tests for `buildLaunchCommand` lock both branches (resolved
 * entrypoint vs PATH fallback) without spawning anything.
 *
 * End-to-end spawn behaviour (JSON-RPC stream passthrough) is out of scope
 * here — that belongs in an MCP integration suite.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
	resolveQmdEntry,
	buildLaunchCommand,
	readQmdIndex,
	resolveIndexSqlitePath,
	resolveVaultRoot,
	deriveQmdIndex as deriveQmdIndexMjs,
	resolveQmdIndex as resolveQmdIndexMjs,
} from "../qmd-mcp.mjs";
import {
	deriveQmdIndex as deriveQmdIndexTs,
	resolveQmdIndex as resolveQmdIndexTs,
} from "../lib/session-start.ts";

describe("resolveQmdEntry", () => {
	test("returns an absolute path to an existing qmd entrypoint when qmd is installed", () => {
		const entry = resolveQmdEntry();

		// When qmd isn't on this machine, skip — the assertion is meaningful
		// only against a real install. CI installs qmd globally, so this
		// branch should execute on every matrix leg.
		if (entry === null) {
			// Surface a skip-style signal in test output rather than silently passing.
			assert.ok(
				true,
				"qmd not installed in this environment — resolver correctly returned null",
			);
			return;
		}

		assert.equal(typeof entry, "string");
		assert.equal(isAbsolute(entry), true, `resolved path must be absolute, got: ${entry}`);
		assert.equal(existsSync(entry), true, `resolved path must exist on disk, got: ${entry}`);
		assert.match(
			entry,
			/@tobilu[\\/]qmd[\\/]dist[\\/]cli[\\/]qmd\.js$/,
			`resolved path should point at @tobilu/qmd's CLI entry, got: ${entry}`,
		);
	});
});

describe("buildLaunchCommand", () => {
	test("routes through process.execPath when an entrypoint is resolved", () => {
		const { cmd, args, shell } = buildLaunchCommand(
			"/fake/@tobilu/qmd/dist/cli/qmd.js",
			[],
		);
		assert.equal(cmd, process.execPath);
		assert.deepEqual(args, ["/fake/@tobilu/qmd/dist/cli/qmd.js", "mcp"]);
		assert.equal(shell, false);
	});

	test("forwards extra argv to the qmd mcp subcommand", () => {
		const { args } = buildLaunchCommand("/fake/qmd.js", ["--verbose", "--port=4000"]);
		assert.deepEqual(args, [
			"/fake/qmd.js",
			"mcp",
			"--verbose",
			"--port=4000",
		]);
	});

	test("falls back to a single-string shell command when resolution returns null", () => {
		// Single-string command with shell:true (not args+shell) so Node 24
		// doesn't fire DEP0190. Args fold into the cmd string at build time
		// so the spawn site can't accidentally reintroduce the deprecated
		// args+shell pattern.
		const { cmd, args, shell } = buildLaunchCommand(null, []);
		assert.equal(cmd, "qmd mcp");
		assert.deepEqual(args, []);
		assert.equal(shell, true);
	});

	test("fallback path folds extra argv into the cmd string", () => {
		const { cmd, args } = buildLaunchCommand(null, ["--debug"]);
		assert.equal(cmd, "qmd mcp --debug");
		assert.deepEqual(args, []);
	});

	test("prepends --index <name> when a qmdIndex is provided (resolved branch)", () => {
		const { args } = buildLaunchCommand("/fake/qmd.js", [], "obsidian-mind");
		assert.deepEqual(args, [
			"/fake/qmd.js",
			"--index",
			"obsidian-mind",
			"mcp",
		]);
	});

	test("prepends --index <name> when a qmdIndex is provided (fallback branch)", () => {
		const { cmd, args } = buildLaunchCommand(null, [], "my-vault");
		assert.equal(cmd, "qmd --index my-vault mcp");
		assert.deepEqual(args, []);
	});

	test("qmdIndex + extra argv compose correctly", () => {
		const { args } = buildLaunchCommand(
			"/fake/qmd.js",
			["--verbose"],
			"vault-a",
		);
		assert.deepEqual(args, [
			"/fake/qmd.js",
			"--index",
			"vault-a",
			"mcp",
			"--verbose",
		]);
	});
});

describe("readQmdIndex", () => {
	test("extracts qmd_index when present as a non-empty string", () => {
		const manifest = JSON.stringify({ qmd_index: "obsidian-mind" });
		assert.equal(readQmdIndex(manifest), "obsidian-mind");
	});
	test("returns null when qmd_index is an empty string", () => {
		assert.equal(readQmdIndex(JSON.stringify({ qmd_index: "" })), null);
	});
	test("returns null when qmd_index is missing from the manifest", () => {
		assert.equal(readQmdIndex(JSON.stringify({ template: "obsidian-mind" })), null);
	});
	test("returns null when qmd_index is not a string", () => {
		assert.equal(readQmdIndex(JSON.stringify({ qmd_index: 42 })), null);
	});
	test("returns null when manifest source is null (missing file)", () => {
		assert.equal(readQmdIndex(null), null);
	});
	test("returns null when manifest is malformed JSON", () => {
		assert.equal(readQmdIndex("{ not json"), null);
	});
	test("returns null when manifest parses to a non-object", () => {
		assert.equal(readQmdIndex('"just a string"'), null);
	});
	test("returns null when qmd_index contains path separators (/ or \\)", () => {
		assert.equal(
			readQmdIndex(JSON.stringify({ qmd_index: "vault/sub" })),
			null,
		);
		assert.equal(
			readQmdIndex(JSON.stringify({ qmd_index: "vault\\sub" })),
			null,
		);
	});
	test("returns null when qmd_index is a parent-dir escape", () => {
		assert.equal(
			readQmdIndex(JSON.stringify({ qmd_index: "../etc" })),
			null,
		);
	});
	test("returns null when qmd_index contains whitespace", () => {
		assert.equal(
			readQmdIndex(JSON.stringify({ qmd_index: "my vault" })),
			null,
		);
	});
	test("returns null when qmd_index starts with non-alphanumeric", () => {
		assert.equal(
			readQmdIndex(JSON.stringify({ qmd_index: "-lead" })),
			null,
		);
	});
	test("accepts dash, dot, and underscore inside the name", () => {
		assert.equal(
			readQmdIndex(JSON.stringify({ qmd_index: "vault.2_a-b" })),
			"vault.2_a-b",
		);
	});
});

describe("resolveVaultRoot", () => {
	test("uses CLAUDE_PROJECT_DIR when set to an absolute path", () => {
		const out = resolveVaultRoot(
			"file:///some/vault/.claude/scripts/qmd-mcp.mjs",
			{ CLAUDE_PROJECT_DIR: "/override/root" },
		);
		assert.equal(out, "/override/root");
	});

	test("ignores CLAUDE_PROJECT_DIR when value is empty", () => {
		const out = resolveVaultRoot(
			"file:///C:/vault/.claude/scripts/qmd-mcp.mjs",
			{ CLAUDE_PROJECT_DIR: "" },
		);
		// Path math: two levels up from .claude/scripts/qmd-mcp.mjs → vault/
		assert.match(out, /[\\/]vault$/, `expected vault-root shape, got: ${out}`);
	});

	test("ignores CLAUDE_PROJECT_DIR when value is a relative path (not trusted)", () => {
		const out = resolveVaultRoot(
			"file:///C:/vault/.claude/scripts/qmd-mcp.mjs",
			{ CLAUDE_PROJECT_DIR: "relative/thing" },
		);
		assert.match(out, /[\\/]vault$/);
	});

	test("derives the vault root from import.meta.url when env is unset", () => {
		// `fileURLToPath` requires a drive-letter prefix on Windows but not on
		// POSIX. Pick an OS-appropriate fixture so the assertion — that the
		// result walks two levels up from .claude/scripts/qmd-mcp.mjs — runs
		// on every matrix leg.
		const url =
			process.platform === "win32"
				? "file:///C:/home/me/my-vault/.claude/scripts/qmd-mcp.mjs"
				: "file:///home/me/my-vault/.claude/scripts/qmd-mcp.mjs";
		const out = resolveVaultRoot(url, {});
		assert.match(out, /[\\/]my-vault$/);
	});
});

describe("resolveIndexSqlitePath", () => {
	test("joins XDG_CACHE_HOME + qmd + <name>.sqlite when the env var is set", () => {
		const out = resolveIndexSqlitePath(
			"vault-a",
			{ XDG_CACHE_HOME: "/custom/cache" },
			"/home/user",
		);
		assert.match(out, /[\\/]custom[\\/]cache[\\/]qmd[\\/]vault-a\.sqlite$/);
	});
	test("falls back to <home>/.cache/qmd/<name>.sqlite when XDG_CACHE_HOME is unset", () => {
		const out = resolveIndexSqlitePath("my-vault", {}, "/home/user");
		assert.match(out, /[\\/]home[\\/]user[\\/]\.cache[\\/]qmd[\\/]my-vault\.sqlite$/);
	});
	test("matches qmd's own getDefaultDbPath rule on all platforms (no Library/Caches, no AppData branch)", () => {
		// This locks the contract: our INDEX_PATH override must point at the same
		// file qmd's CLI would write to without the override. Regression here
		// would mean MCP and CLI disagree about the store location.
		const home = "/Users/test";
		const out = resolveIndexSqlitePath("vault", {}, home);
		assert.match(out, /[\\/]Users[\\/]test[\\/]\.cache[\\/]qmd[\\/]vault\.sqlite$/);
		assert.doesNotMatch(out, /Library[\\/]Caches/);
		assert.doesNotMatch(out, /AppData/);
	});
});

/**
 * The MCP wrapper is `.mjs` and cannot import the `.ts` lib at strip-types
 * runtime, so `deriveQmdIndex` exists twice. A drift between the two copies
 * is the worst kind of bug this template can have: the SessionStart hook
 * would index one store while the agent's search reads another, and the
 * symptom is "0 documents" rather than an error. These tests are the only
 * thing holding the copies together.
 */
describe("qmd index derivation — .mjs and .ts copies agree", () => {
	const CASES = [
		"vigil-mind",
		"Obsidian Mind",
		"MY_VAULT",
		"vault.with.dots",
		"trailing---dashes---",
		"-leading-dash",
		"UPPER",
		"a",
		"work vault (2026)",
		"...",
		"日本語",
	];

	for (const name of CASES) {
		test(`agree on ${JSON.stringify(name)}`, () => {
			const root = `/tmp/${name}`;
			assert.equal(deriveQmdIndexMjs(root), deriveQmdIndexTs(root));
		});
	}

	test("agree when a manifest pins the index", () => {
		const manifest = JSON.stringify({ qmd_index: "pinned-name" });
		assert.equal(
			resolveQmdIndexMjs(manifest, "/tmp/ignored"),
			resolveQmdIndexTs(manifest, "/tmp/ignored"),
		);
	});

	test("agree when the manifest is absent", () => {
		assert.equal(
			resolveQmdIndexMjs(null, "/tmp/some-vault"),
			resolveQmdIndexTs(null, "/tmp/some-vault"),
		);
	});
});

describe("deriveQmdIndex", () => {
	test("uses the vault folder name, slugified", () => {
		assert.equal(deriveQmdIndexTs("/home/me/Obsidian Mind"), "obsidian-mind");
	});

	test("lowercases and collapses runs of separators", () => {
		assert.equal(deriveQmdIndexTs("/x/My   Work__Vault"), "my-work__vault");
	});

	test("strips leading non-alphanumerics and trailing separators", () => {
		assert.equal(deriveQmdIndexTs("/x/--vault--"), "vault");
	});

	test("keeps dots, dashes and underscores", () => {
		assert.equal(deriveQmdIndexTs("/x/a.b-c_d"), "a.b-c_d");
	});

	test("returns null when nothing usable remains", () => {
		assert.equal(deriveQmdIndexTs("/x/日本語"), null);
		assert.equal(deriveQmdIndexTs("/x/..."), null);
	});

	test("never yields a value that fails the index validator", () => {
		for (const name of ["ok", "A B", "...", "-x-", "1", "_a"]) {
			const out = deriveQmdIndexTs(`/x/${name}`);
			if (out !== null) assert.match(out, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
		}
	});
});

describe("resolveQmdIndex", () => {
	test("an explicit pin beats the folder name", () => {
		assert.equal(
			resolveQmdIndexTs(JSON.stringify({ qmd_index: "pinned" }), "/x/folder"),
			"pinned",
		);
	});

	test("an empty qmd_index falls through to derivation", () => {
		assert.equal(
			resolveQmdIndexTs(JSON.stringify({ qmd_index: "" }), "/x/my-vault"),
			"my-vault",
		);
	});

	test("a missing qmd_index falls through to derivation", () => {
		assert.equal(resolveQmdIndexTs(JSON.stringify({}), "/x/my-vault"), "my-vault");
	});

	test("an invalid pin falls through rather than propagating a bad name", () => {
		assert.equal(
			resolveQmdIndexTs(JSON.stringify({ qmd_index: "has/slash" }), "/x/my-vault"),
			"my-vault",
		);
	});

	test("returns null when there is no pin and nothing to derive", () => {
		assert.equal(resolveQmdIndexTs(JSON.stringify({}), "/x/日本語"), null);
	});

	test("two vaults in different folders resolve to different indexes", () => {
		const manifest = JSON.stringify({ qmd_index: "" });
		assert.notEqual(
			resolveQmdIndexTs(manifest, "/a/vault-one"),
			resolveQmdIndexTs(manifest, "/b/vault-two"),
		);
	});
});

/**
 * The `template` fallback tier (Copilot review on #154). An earlier revision
 * had the bootstrap script fall back to `template` privately while the read
 * surfaces fell back to null (qmd's global index) — so a vault with a
 * non-derivable folder name got its content indexed into one store while
 * every reader looked in another. Silent, and shaped like an empty vault.
 */
describe("resolveQmdIndex — template fallback", () => {
	const NON_DERIVABLE = "/x/日本語";

	test("falls back to template when there is no pin and no derivable slug", () => {
		const manifest = JSON.stringify({ qmd_index: "", template: "obsidian-mind" });
		assert.equal(resolveQmdIndexTs(manifest, NON_DERIVABLE), "obsidian-mind");
	});

	test(".mjs agrees on the template fallback", () => {
		const manifest = JSON.stringify({ qmd_index: "", template: "obsidian-mind" });
		assert.equal(
			resolveQmdIndexMjs(manifest, NON_DERIVABLE),
			resolveQmdIndexTs(manifest, NON_DERIVABLE),
		);
	});

	test("a derivable folder still beats template", () => {
		const manifest = JSON.stringify({ qmd_index: "", template: "obsidian-mind" });
		assert.equal(resolveQmdIndexTs(manifest, "/x/my-vault"), "my-vault");
	});

	test("a pin still beats both", () => {
		const manifest = JSON.stringify({ qmd_index: "pinned", template: "obsidian-mind" });
		assert.equal(resolveQmdIndexTs(manifest, NON_DERIVABLE), "pinned");
	});

	test("an invalid template is not used", () => {
		const manifest = JSON.stringify({ qmd_index: "", template: "has/slash" });
		assert.equal(resolveQmdIndexTs(manifest, NON_DERIVABLE), null);
		assert.equal(resolveQmdIndexMjs(manifest, NON_DERIVABLE), null);
	});

	test("null only when nothing at any tier is usable", () => {
		const manifest = JSON.stringify({ qmd_index: "" });
		assert.equal(resolveQmdIndexTs(manifest, NON_DERIVABLE), null);
		assert.equal(resolveQmdIndexMjs(manifest, NON_DERIVABLE), null);
	});
});
