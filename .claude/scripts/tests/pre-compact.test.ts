/**
 * Unit tests for pre-compact helpers: timestamp format and retention-based pruning.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	formatTimestamp,
	listBackups,
	pruneBackups,
} from "../pre-compact.ts";

describe("formatTimestamp", () => {
	test("pads single digits (YYYYMMDD_HHMMSS)", () => {
		const d = new Date(2026, 3, 5, 9, 7, 3); // month is 0-indexed → April
		assert.equal(formatTimestamp(d), "20260405_090703");
	});
	test("two-digit components pass through", () => {
		const d = new Date(2026, 9, 31, 23, 59, 59); // October 31
		assert.equal(formatTimestamp(d), "20261031_235959");
	});
});

describe("listBackups + pruneBackups", () => {
	let dir = "";

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "pre-compact-test-"));
	});

	after(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function makeBackup(name: string, ageSeconds: number): void {
		const path = join(dir, name);
		writeFileSync(path, "stub");
		const t = Date.now() / 1000 - ageSeconds;
		utimesSync(path, t, t);
	}

	test("lists only session_*.jsonl, sorted newest-first", () => {
		makeBackup("session_a_20260101_000000.jsonl", 100);
		makeBackup("session_b_20260102_000000.jsonl", 50);
		makeBackup("session_c_20260103_000000.jsonl", 10);
		writeFileSync(join(dir, "unrelated.txt"), "nope");
		writeFileSync(join(dir, "session_missing_suffix"), "nope");

		const ordered = listBackups(dir);
		assert.deepEqual(ordered, [
			"session_c_20260103_000000.jsonl",
			"session_b_20260102_000000.jsonl",
			"session_a_20260101_000000.jsonl",
		]);
	});

	test("prune keeps N newest by mtime", () => {
		pruneBackups(dir, 2);
		const remaining = readdirSync(dir)
			.filter((f) => f.startsWith("session_") && f.endsWith(".jsonl"))
			.sort();
		assert.deepEqual(remaining, [
			"session_b_20260102_000000.jsonl",
			"session_c_20260103_000000.jsonl",
		]);
	});

	test("prune with retain ≥ count is a no-op", () => {
		const before = readdirSync(dir).length;
		pruneBackups(dir, 100);
		const after = readdirSync(dir).length;
		assert.equal(before, after);
	});

	test("listBackups on missing dir returns []", () => {
		assert.deepEqual(listBackups("/nonexistent/dir/xyz"), []);
	});
});
