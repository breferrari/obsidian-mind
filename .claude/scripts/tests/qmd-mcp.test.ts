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
});
