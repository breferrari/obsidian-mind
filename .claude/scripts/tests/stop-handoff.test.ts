/**
 * lib/stop-handoff.ts: a Stop report saved for the session's next prompt.
 * Delivered once, never to another session, newest wins, stale ones pruned.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { rmTemp } from "./_helpers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_MAX_AGE_MS, handoffPath, pruneHandoffs, takeHandoff, writeHandoff } from "../lib/stop-handoff.ts";

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "stop-handoff-"));
	try {
		fn(dir);
	} finally {
		rmTemp(dir);
	}
}

describe("stop-handoff", () => {
	test("a report is taken once, and nothing is left behind", () => withDir((dir) => {
		writeHandoff(dir, "s1", "report");
		assert.equal(takeHandoff(dir, "s1"), "report");
		assert.equal(takeHandoff(dir, "s1"), null);
		assert.deepEqual(readdirSync(dir), []);
	}));

	test("nothing waiting is null, not a throw, even with no directory", () => withDir((dir) => {
		assert.equal(takeHandoff(join(dir, "missing"), "s1"), null);
	}));

	test("the newest report replaces an unread one", () => withDir((dir) => {
		writeHandoff(dir, "s1", "old");
		writeHandoff(dir, "s1", "new");
		assert.equal(takeHandoff(dir, "s1"), "new");
	}));

	test("sessions are kept apart, and an id cannot escape the directory", () => withDir((dir) => {
		writeHandoff(dir, "a", "for a");
		assert.equal(takeHandoff(dir, "b"), null);
		assert.ok(handoffPath(dir, "../../etc/x").startsWith(dir));
		assert.equal(takeHandoff(dir, "a"), "for a");
	}));

	test("reports older than the window are pruned; fresh ones stay", () => withDir((dir) => {
		writeHandoff(dir, "old", "x");
		writeHandoff(dir, "fresh", "y");
		const now = Date.now();
		const stale = new Date(now - HANDOFF_MAX_AGE_MS - 60_000);
		utimesSync(handoffPath(dir, "old"), stale, stale);
		pruneHandoffs(dir, now);
		assert.equal(takeHandoff(dir, "old"), null);
		assert.equal(takeHandoff(dir, "fresh"), "y");
	}));
});
