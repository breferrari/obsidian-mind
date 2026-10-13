/**
 * Unit tests for lib/main-guard — detect direct-script invocation vs import.
 *
 * The function compares `fileURLToPath(importMetaUrl)` against `process.argv[1]`,
 * resolving argv[1]'s real path too (obsidian-mind#391).
 * We can't mutate `import.meta.url`, but we can pass a synthetic value and
 * stage `process.argv[1]` to cover the matrix.
 */

import { test, describe, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../lib/main-guard.ts";
import { hostPath, rmTemp } from "./_helpers.ts";

const ORIGINAL_ARGV1: string | undefined = process.argv[1];

afterEach(() => {
	// Restore argv so a failing test can't cascade into unrelated ones.
	if (ORIGINAL_ARGV1 === undefined) {
		process.argv.length = 1;
	} else {
		process.argv[1] = ORIGINAL_ARGV1;
	}
});

describe("isMainModule", () => {
	test("true when argv[1] matches the module path", () => {
		const path = hostPath("/Users/dev/scripts/foo.ts");
		process.argv[1] = path;
		assert.equal(isMainModule(pathToFileURL(path).href), true);
	});

	test("false when argv[1] differs from the module path", () => {
		process.argv[1] = hostPath("/Users/dev/scripts/other.ts");
		assert.equal(
			isMainModule(pathToFileURL(hostPath("/Users/dev/scripts/foo.ts")).href),
			false,
		);
	});

	test("false when argv[1] is undefined (node -e or repl)", () => {
		// Truncating argv represents the absent-entry case from node -e / repl
		// without tripping tsc's rejection of `delete` on non-optional indexes.
		process.argv.length = 1;
		assert.equal(
			isMainModule(pathToFileURL(hostPath("/Users/dev/scripts/foo.ts")).href),
			false,
		);
	});

	test("handles URL-encoded segments (spaces in path)", () => {
		const path = hostPath("/Users/dev/my scripts/foo.ts");
		process.argv[1] = path;
		// pathToFileURL encodes the space as %20; isMainModule must decode
		// before comparing against the raw argv path.
		assert.equal(isMainModule(pathToFileURL(path).href), true);
	});

	describe("through a symlinked folder (obsidian-mind#391)", () => {
		// Node gives the entry module its real path; argv[1] keeps the path as typed,
		// as for a vault under macOS's /var, a symlink to /private/var.
		let root = "";
		let linked = true;
		before(() => {
			root = mkdtempSync(join(tmpdir(), "main-guard-"));
			mkdirSync(join(root, "real"));
			writeFileSync(join(root, "real", "foo.ts"), "");
			writeFileSync(join(root, "real", "bar.ts"), "");
			try {
				symlinkSync(join(root, "real"), join(root, "link"), "junction");
			} catch {
				linked = false;
			}
		});
		after(() => rmTemp(root));
		const realUrl = (name: string) => pathToFileURL(realpathSync(join(root, "real", name))).href;

		test("true when argv[1] reaches the module through the link", (t) => {
			if (!linked) return t.skip("no symlink rights here");
			process.argv[1] = join(root, "link", "foo.ts");
			assert.equal(isMainModule(realUrl("foo.ts")), true);
		});

		test("false when argv[1] reaches another file through the link", (t) => {
			if (!linked) return t.skip("no symlink rights here");
			process.argv[1] = join(root, "link", "bar.ts");
			assert.equal(isMainModule(realUrl("foo.ts")), false);
		});

		test("false when argv[1] names no file, so it can't be resolved", () => {
			process.argv[1] = join(root, "link", "gone.ts");
			assert.equal(isMainModule(realUrl("foo.ts")), false);
		});
	});
});
