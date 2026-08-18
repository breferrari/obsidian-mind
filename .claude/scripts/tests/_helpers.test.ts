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

import { rmTemp, waitFor } from "./_helpers.ts";

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
		"swallows a removal it is not permitted to make",
		{ skip: process.platform === "win32" || process.getuid?.() === 0 },
		() => {
			// The red for #235: with a bare rmSync this throws EACCES out of an
			// `after` hook and fails a suite whose assertions all passed.
			const parent = mkdtempSync(join(tmpdir(), "rmtemp-locked-"));
			const child = join(parent, "child");
			mkdirSync(child);
			chmodSync(parent, 0o500);
			try {
				rmTemp(child);
				assert.equal(existsSync(child), true, "the removal really did fail");
			} finally {
				chmodSync(parent, 0o700);
				rmTemp(parent);
			}
		},
	);
});
