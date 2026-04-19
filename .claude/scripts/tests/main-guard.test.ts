/**
 * Unit tests for lib/main-guard — detect direct-script invocation vs import.
 *
 * The function compares `fileURLToPath(importMetaUrl)` against `process.argv[1]`.
 * We can't mutate `import.meta.url`, but we can pass a synthetic value and
 * stage `process.argv[1]` to cover the matrix.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../lib/main-guard.ts";

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
		const path = "/Users/dev/scripts/foo.ts";
		process.argv[1] = path;
		assert.equal(isMainModule(pathToFileURL(path).href), true);
	});

	test("false when argv[1] differs from the module path", () => {
		process.argv[1] = "/Users/dev/scripts/other.ts";
		assert.equal(
			isMainModule(pathToFileURL("/Users/dev/scripts/foo.ts").href),
			false,
		);
	});

	test("false when argv[1] is undefined (node -e or repl)", () => {
		// Truncating argv represents the absent-entry case from node -e / repl
		// without tripping tsc's rejection of `delete` on non-optional indexes.
		process.argv.length = 1;
		assert.equal(
			isMainModule(pathToFileURL("/Users/dev/scripts/foo.ts").href),
			false,
		);
	});

	test("handles URL-encoded segments (spaces in path)", () => {
		const path = "/Users/dev/my scripts/foo.ts";
		process.argv[1] = path;
		// pathToFileURL encodes the space as %20; isMainModule must decode
		// before comparing against the raw argv path.
		assert.equal(isMainModule(pathToFileURL(path).href), true);
	});
});
