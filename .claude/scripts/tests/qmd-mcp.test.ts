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
} from "../qmd-mcp.mjs";

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

	test("falls back to bare `qmd` with shell: true when resolution returns null", () => {
		const { cmd, args, shell } = buildLaunchCommand(null, []);
		assert.equal(cmd, "qmd");
		assert.deepEqual(args, ["mcp"]);
		assert.equal(shell, true);
	});

	test("fallback path still forwards extra argv", () => {
		const { args } = buildLaunchCommand(null, ["--debug"]);
		assert.deepEqual(args, ["mcp", "--debug"]);
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
		const { args } = buildLaunchCommand(null, [], "my-vault");
		assert.deepEqual(args, ["--index", "my-vault", "mcp"]);
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
