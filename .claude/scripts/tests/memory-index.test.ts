/**
 * Tests for the MEMORY.md regen property (#125): the index is a DERIVED
 * view — deterministic, pointer-only, rebuildable with zero authored loss
 * because nothing authored is permitted in it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	MEMORY_INDEX_HEADER,
	generateMemoryIndex,
	type BrainNote,
} from "../lib/memory-index.ts";

const NOTES: readonly BrainNote[] = [
	{ name: "Patterns", description: "Recurring patterns and conventions" },
	{ name: "Gotchas", description: "Things that bit before" },
	{ name: "Key Decisions", description: null },
];

describe("generateMemoryIndex", () => {
	test("deterministic: same input → byte-identical output, order-independent", () => {
		const a = generateMemoryIndex(NOTES);
		const b = generateMemoryIndex([...NOTES].reverse());
		assert.equal(a, b);
	});

	test("pointer-only: every content line is traceable to an input note", () => {
		const out = generateMemoryIndex(NOTES);
		const contentLines = out
			.split("\n")
			.filter((l) => l.startsWith("- "));
		assert.equal(contentLines.length, NOTES.length);
		for (const line of contentLines) {
			assert.match(line, /^- \[\[brain\/.+\]\] — /);
			const name = line.match(/^\- \[\[brain\/(.+?)\]\]/)?.[1];
			assert.ok(NOTES.some((n) => n.name === name), `untraceable line: ${line}`);
		}
	});

	test("regen property: delete-and-rebuild loses nothing authored (there is nothing authored)", () => {
		const first = generateMemoryIndex(NOTES);
		// Simulate deletion + regeneration from the same sources.
		const rebuilt = generateMemoryIndex(NOTES);
		assert.equal(first, rebuilt);
		// Header declares the contract.
		assert.ok(first.startsWith(MEMORY_INDEX_HEADER));
		assert.match(first, /hand edits will be overwritten/);
	});

	test("sorted case-insensitively; missing description gets the fallback", () => {
		const out = generateMemoryIndex(NOTES);
		const lines = out.split("\n").filter((l) => l.startsWith("- "));
		assert.match(lines[0] ?? "", /Gotchas/);
		assert.match(lines[1] ?? "", /Key Decisions.*\(no description\)/);
		assert.match(lines[2] ?? "", /Patterns/);
	});

	test("empty brain → header only, no dangling lines", () => {
		const out = generateMemoryIndex([]);
		assert.equal(out, MEMORY_INDEX_HEADER + "\n\n");
	});
});

describe("determinism under case-collisions", () => {
	test("names differing only by case get one canonical order, input-order-independent", () => {
		const a = generateMemoryIndex([
			{ name: "foo", description: "lower" },
			{ name: "Foo", description: "upper" },
		]);
		const b = generateMemoryIndex([
			{ name: "Foo", description: "upper" },
			{ name: "foo", description: "lower" },
		]);
		assert.equal(a, b);
		assert.ok(a.indexOf("[[brain/Foo]]") < a.indexOf("[[brain/foo]]"));
	});
});
