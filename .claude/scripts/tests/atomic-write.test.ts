/**
 * lib/atomic-write.ts writeFileAtomic: replace a file whole, or leave nothing behind.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import { rmTemp } from "./_helpers.ts";

describe("writeFileAtomic", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
	});
	afterEach(() => {
		rmTemp(dir);
	});

	test("writes a new file and replaces an existing one", () => {
		const path = join(dir, "state.json");
		writeFileAtomic(path, "first");
		writeFileAtomic(path, "second");
		assert.equal(readFileSync(path, "utf8"), "second");
		assert.deepEqual(readdirSync(dir), ["state.json"], "no temp file left behind");
	});

	test("a write that cannot land throws and removes its temp file", () => {
		// A directory where the file should be: the rename fails.
		const path = join(dir, "taken");
		mkdirSync(path);
		writeFileSync(join(path, "keep"), "");
		assert.throws(() => writeFileAtomic(path, "text"));
		assert.deepEqual(readdirSync(dir), ["taken"], "the temp file was removed");
	});
});
