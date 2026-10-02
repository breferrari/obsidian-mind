/**
 * Unit tests for lib/report-key.ts — a report's identity ignores sizes, ages,
 * and the order those impose, and changes with anything else.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonical, reportKey } from "../lib/report-key.ts";

const VOLATILE = new Set(["sizeKb", "ageDays"]);

describe("reportKey", () => {
	test("volatile values do not change the key", () => {
		const a = { notes: [{ path: "a.md", sizeKb: 26 }] };
		const b = { notes: [{ path: "a.md", sizeKb: 40 }] };
		assert.equal(reportKey(a, VOLATILE), reportKey(b, VOLATILE));
	});

	test("the order a volatile value sorts findings into does not change the key", () => {
		// Sorted by size, largest first: growing b.md past a.md reorders them.
		const before = { notes: [{ path: "a.md", sizeKb: 30 }, { path: "b.md", sizeKb: 26 }] };
		const after = { notes: [{ path: "b.md", sizeKb: 34 }, { path: "a.md", sizeKb: 30 }] };
		assert.equal(reportKey(before, VOLATILE), reportKey(after, VOLATILE));
	});

	test("a new, removed or renamed finding changes the key", () => {
		const base = reportKey({ notes: [{ path: "a.md", sizeKb: 26 }] }, VOLATILE);
		assert.notEqual(reportKey({ notes: [{ path: "a.md" }, { path: "b.md" }] }, VOLATILE), base);
		assert.notEqual(reportKey({ notes: [] }, VOLATILE), base);
		assert.notEqual(reportKey({ notes: [{ path: "c.md", sizeKb: 26 }] }, VOLATILE), base);
	});

	test("non-volatile numbers still count", () => {
		const a = { loops: [{ path: "x.md", openItems: 1, ageDays: 20 }] };
		const b = { loops: [{ path: "x.md", openItems: 2, ageDays: 20 }] };
		assert.notEqual(reportKey(a, VOLATILE), reportKey(b, VOLATILE));
	});

	test("canonical drops volatile keys at any depth and sorts object keys", () => {
		assert.deepEqual(canonical({ b: 1, a: { ageDays: 3, path: "p" } }, VOLATILE), { a: { path: "p" }, b: 1 });
		assert.deepEqual(Object.keys(canonical({ z: 1, a: 2 }, VOLATILE) as object), ["a", "z"]);
	});
});
