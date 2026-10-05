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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
	buildQmdCommand,
	isRunnableQmdEntry,
	parseVersionTriple,
	pickQmdEntry,
	qmdVersionAtLeast,
	resolveQmdEntry,
} from "../lib/qmd.ts";
import {
	isRunnableQmdEntry as isRunnableQmdEntryMjs,
	pickQmdEntry as pickQmdEntryMjs,
} from "../qmd-mcp.mjs";

/**
 * A present-but-broken install used to win just by existing: the first
 * candidate that resolved was returned, so a broken local copy shadowed a
 * working global one. Both copies of the picker run the same cases.
 */
for (const [label, pick, isRunnable] of [
	["lib/qmd.ts", pickQmdEntry, isRunnableQmdEntry],
	["qmd-mcp.mjs", pickQmdEntryMjs, isRunnableQmdEntryMjs],
] as const) {
	describe(`${label} pickQmdEntry`, () => {
		const probe = (ok: ReadonlySet<string>) => {
			const probed: string[] = [];
			return {
				probed,
				runnable: (e: string) => {
					probed.push(e);
					return ok.has(e);
				},
			};
		};

		test("a broken first candidate does not shadow a runnable second", () => {
			const p = probe(new Set(["global"]));
			assert.equal(pick([() => "local", () => "global"], p.runnable), "global");
		});

		test("every candidate broken → the first present, so the ABI self-heal still has a package", () => {
			const p = probe(new Set());
			assert.equal(pick([() => "local", () => "global"], p.runnable), "local");
		});

		test("nothing present → null", () => {
			const p = probe(new Set());
			assert.equal(pick([() => null, () => null], p.runnable), null);
			assert.deepEqual(p.probed, []);
		});

		test("a lone candidate is returned without a probe", () => {
			const p = probe(new Set());
			assert.equal(pick([() => null, () => "global"], p.runnable), "global");
			assert.deepEqual(p.probed, []);
		});

		test("a runnable first candidate skips the later lookups", () => {
			const p = probe(new Set(["local"]));
			let looked = false;
			const later = () => {
				looked = true;
				return "global";
			};
			assert.equal(pick([() => "local", later], p.runnable), "local");
			assert.equal(looked, false);
		});
	});

	describe(`${label} isRunnableQmdEntry`, () => {
		test("an entry that exits 0 is runnable; one that throws on load is not", () => {
			const dir = mkdtempSync(join(tmpdir(), "qmd-probe-"));
			try {
				const good = join(dir, "good.mjs");
				const bad = join(dir, "bad.mjs");
				writeFileSync(good, "process.stdout.write('qmd 9.9.9\\n');\n");
				writeFileSync(bad, "throw new Error('Cannot find module better-sqlite3');\n");
				assert.equal(isRunnable(good), true);
				assert.equal(isRunnable(bad), false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
}

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

	test("falls back to a single-string shell command when resolution returns null", () => {
		// Single-string command with shell:true (not args+shell) so Node 24
		// doesn't fire DEP0190 about unescaped concatenation. Args fold into
		// the command string at build time so callers never reintroduce the
		// deprecated pattern at the spawn site.
		const out = buildQmdCommand(null, ["update"]);
		assert.equal(out.cmd, "qmd update");
		assert.deepEqual(out.args, []);
		assert.equal(out.shell, true);
	});

	test("fallback folds multi-arg subcommands into the single command string", () => {
		const out = buildQmdCommand(null, ["--index", "vault-a", "embed"]);
		assert.equal(out.cmd, "qmd --index vault-a embed");
		assert.deepEqual(out.args, []);
	});

	test("fallback args array is always empty (single-string contract)", () => {
		const input = ["update"];
		const out = buildQmdCommand(null, input);
		assert.deepEqual(out.args, []);
		// And the returned args is its own array, not aliased to the input.
		assert.notEqual(out.args, input);
	});
});

describe("parseVersionTriple", () => {
	test("parses bare x.y.z", () => {
		assert.deepEqual(parseVersionTriple("2.5.3"), [2, 5, 3]);
	});
	test("parses the qmd --version output shape", () => {
		assert.deepEqual(parseVersionTriple("qmd 2.5.3 (655769712a)"), [2, 5, 3]);
	});
	test("null when no triple present", () => {
		assert.equal(parseVersionTriple("qmd dev-build"), null);
		assert.equal(parseVersionTriple(""), null);
		assert.equal(parseVersionTriple("2.5"), null);
	});
});

describe("qmdVersionAtLeast", () => {
	test("true when equal or above", () => {
		assert.equal(qmdVersionAtLeast("qmd 2.5.3 (abc)", "2.5.3"), true);
		assert.equal(qmdVersionAtLeast("qmd 2.5.3 (abc)", "2.0.0"), true);
		assert.equal(qmdVersionAtLeast("3.0.0", "2.9.9"), true);
	});
	test("false when below on any component", () => {
		assert.equal(qmdVersionAtLeast("qmd 1.9.9 (abc)", "2.0.0"), false);
		assert.equal(qmdVersionAtLeast("2.4.9", "2.5.0"), false);
		assert.equal(qmdVersionAtLeast("2.5.2", "2.5.3"), false);
	});
	test("fails open on unparseable input, either side", () => {
		assert.equal(qmdVersionAtLeast("qmd dev-build", "2.0.0"), true);
		assert.equal(qmdVersionAtLeast("2.5.3", "latest"), true);
	});
});
