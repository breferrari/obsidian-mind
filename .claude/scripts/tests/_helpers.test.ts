/**
 * The shared test helpers, which are load-bearing for CI honesty.
 *
 * Both halves of #235 were assumptions about timing rather than defects in
 * what was under test, and both fixes live here — so the properties that make
 * them correct are pinned here too. Each one is a way the fix could be wrong
 * while still looking right: a `waitFor` that hangs instead of returning at
 * the deadline would hide a dead assertion, and an `rmTemp` that throws would
 * reintroduce the exact failure it was written to remove.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { leakedTempDirs, rmTemp, waitFor } from "./_helpers.ts";

describe("waitFor", () => {
	test("returns as soon as the condition holds", async () => {
		let ready = false;
		const t = setTimeout(() => (ready = true), 40);
		const started = Date.now();
		await waitFor(() => ready);
		clearTimeout(t);
		assert.equal(ready, true);
		// The point of polling: it does not pay the full timeout when the signal
		// arrives early, which is what a fixed sleep does by construction.
		assert.ok(Date.now() - started < 2_000, "must not sit out the 5s default");
	});

	test("returns at the deadline instead of hanging, so the caller's assertion is the one that fails", async () => {
		const started = Date.now();
		await waitFor(() => false, 100, 10);
		const elapsed = Date.now() - started;
		// Returning is the whole contract. A helper that threw would replace the
		// test's own message; one that hung would turn a failure into a timeout.
		assert.ok(elapsed >= 80, `waited ${elapsed}ms — must not return before the deadline`);
		assert.ok(elapsed < 5_000, `waited ${elapsed}ms — must not outlive its deadline`);
	});

	test("accepts an async condition", async () => {
		let n = 0;
		await waitFor(async () => ++n >= 3, 2_000, 1);
		assert.ok(n >= 3);
	});
});

describe("rmTemp", () => {
	test("removes the tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "rmtemp-"));
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "nested", "note.md"), "x");
		rmTemp(dir);
		assert.equal(existsSync(dir), false);
	});

	test("is a no-op for an unset path", () => {
		// `let dir = ""` before the `before` hook runs is the shape in every
		// suite, so the guard the call sites used to write inline lives here.
		rmTemp("");
		rmTemp(null);
		rmTemp(undefined);
	});

	test(
		"swallows a removal it is not permitted to make, and RECORDS it",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		() => {
			// The red for #235: with a bare rmSync this throws EACCES out of an
			// `after` hook and fails a suite whose assertions all passed.
			const parent = mkdtempSync(join(tmpdir(), "rmtemp-locked-"));
			const child = join(parent, "child");
			mkdirSync(child);
			chmodSync(parent, 0o500);
			try {
				const before = leakedTempDirs().length;
				rmTemp(child);
				assert.equal(existsSync(child), true, "the removal really did fail");

				// The swallow is only acceptable because it is counted. A silent one
				// keeps the build green and takes away the signal that something
				// outlives the suite, which is the question #235 left open.
				const after = leakedTempDirs();
				assert.equal(after.length, before + 1, "a swallowed failure must be recorded");
				const entry = after.at(-1);
				assert.equal(entry?.dir, child);
				assert.ok(entry?.code, "the errno travels with the path, or the report cannot say why");
			} finally {
				chmodSync(parent, 0o700);
				rmTemp(parent);
			}
		},
	);

	test("records nothing when the removal succeeds", () => {
		// The other half, and the one that would let a false positive through:
		// a recorder that logged every call would report residue on every green
		// run and be ignored inside a week.
		const dir = mkdtempSync(join(tmpdir(), "rmtemp-ok-"));
		const before = leakedTempDirs().length;
		rmTemp(dir);
		assert.equal(existsSync(dir), false);
		assert.equal(leakedTempDirs().length, before, "a successful removal is not residue");
	});

	test(
		"records one entry per surviving tree, not one per attempt",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		() => {
			// The count is read as "how many trees survived". Retrying the same
			// directory must not inflate it. Uses the same locked parent as the
			// test above, because it is the one shape known to fail here: a first
			// draft reached for a path under a regular file, which `force: true`
			// swallows silently, so nothing was recorded and the assertion held
			// for the wrong reason.
			const parent = mkdtempSync(join(tmpdir(), "rmtemp-dedupe-"));
			const child = join(parent, "child");
			mkdirSync(child);
			chmodSync(parent, 0o500);
			try {
				const before = leakedTempDirs().length;
				rmTemp(child);
				assert.equal(leakedTempDirs().length, before + 1, "the first attempt must record, or this proves nothing");
				rmTemp(child);
				assert.equal(leakedTempDirs().length, before + 1, "the second attempt on one path must not add a row");
			} finally {
				chmodSync(parent, 0o700);
				rmTemp(parent);
			}
		},
	);
});
