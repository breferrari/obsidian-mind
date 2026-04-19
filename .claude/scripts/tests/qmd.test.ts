/**
 * Tests for the shared cross-platform qmd spawn helpers.
 *
 * Paired with `tests/qmd-mcp.test.ts` — the MCP wrapper duplicates this
 * logic in .mjs (because .ts imports don't flow from .mjs at strip-types
 * runtime). Both copies are exercised in the CI matrix so drift between
 * them surfaces as a test failure rather than a silent platform bug.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { buildQmdCommand, resolveQmdEntry } from "../lib/qmd.ts";

describe("lib/qmd.resolveQmdEntry", () => {
	test("returns an absolute path to an existing qmd entrypoint when qmd is installed", () => {
		const entry = resolveQmdEntry();

		// When qmd isn't on this machine, the resolver must cleanly return null
		// — the assertion below is meaningful only against a real install.
		// CI installs qmd globally, so the positive branch runs on every
		// matrix leg.
		if (entry === null) {
			assert.ok(
				true,
				"qmd not installed in this environment — resolver correctly returned null",
			);
			return;
		}

		assert.equal(typeof entry, "string");
		assert.equal(
			isAbsolute(entry),
			true,
			`resolved path must be absolute, got: ${entry}`,
		);
		assert.equal(
			existsSync(entry),
			true,
			`resolved path must exist on disk, got: ${entry}`,
		);
		assert.match(
			entry,
			/@tobilu[\\/]qmd[\\/]dist[\\/]cli[\\/]qmd\.js$/,
			`resolved path should point at @tobilu/qmd's CLI entry, got: ${entry}`,
		);
	});
});

describe("lib/qmd.buildQmdCommand", () => {
	test("routes through process.execPath when an entrypoint is resolved", () => {
		const out = buildQmdCommand("/fake/qmd.js", ["update"]);
		assert.equal(out.cmd, process.execPath);
		assert.deepEqual(out.args, ["/fake/qmd.js", "update"]);
		assert.equal(out.shell, false);
	});

	test("forwards multi-arg subcommands", () => {
		const out = buildQmdCommand("/fake/qmd.js", [
			"--index",
			"vault-a",
			"query",
			"hello",
		]);
		assert.deepEqual(out.args, [
			"/fake/qmd.js",
			"--index",
			"vault-a",
			"query",
			"hello",
		]);
	});

	test("falls back to bare `qmd` with shell: true when resolution returns null", () => {
		const out = buildQmdCommand(null, ["update"]);
		assert.equal(out.cmd, "qmd");
		assert.deepEqual(out.args, ["update"]);
		assert.equal(out.shell, true);
	});

	test("fallback forwards multi-arg subcommands", () => {
		const out = buildQmdCommand(null, ["--index", "vault-a", "embed"]);
		assert.deepEqual(out.args, ["--index", "vault-a", "embed"]);
	});

	test("returns a fresh args array (does not alias the input)", () => {
		const input = ["update"];
		const out = buildQmdCommand(null, input);
		assert.notEqual(out.args, input);
	});
});
