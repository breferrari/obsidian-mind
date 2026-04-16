/**
 * Unit tests for charcount section extraction and result formatting.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { countSection, formatResult } from "../lib/charcount.ts";

describe("countSection — plain section", () => {
	const doc = [
		"# Title",
		"",
		"### Intro",
		"",
		"Hello world.",
		"",
		"### Body",
		"",
		"Second section.",
		"More content.",
		"",
		"### Outro",
		"",
		"Closing.",
		"",
		"## Next top",
		"should not be included",
	].join("\n");

	test("counts the requested section only", () => {
		assert.equal(countSection(doc, { section: "Intro" }), "Hello world.".length);
	});

	test("stops at next ### heading", () => {
		assert.equal(
			countSection(doc, { section: "Body" }),
			"Second section.More content.".length,
		);
	});

	test("stops at next ## heading", () => {
		assert.equal(countSection(doc, { section: "Outro" }), "Closing.".length);
	});

	test("returns 0 for missing section", () => {
		assert.equal(countSection(doc, { section: "Nope" }), 0);
	});

	test("empty lines inside a section are skipped", () => {
		const d = ["### S", "", "a", "", "b", "", "### Other"].join("\n");
		assert.equal(countSection(d, { section: "S" }), 2);
	});
});

describe("countSection — with sub-marker", () => {
	const doc = [
		"### Project Name",
		"",
		"**Current Level:**",
		"senior",
		"engineer",
		"",
		"**Next Level:**",
		"staff",
		"",
		"### Other",
	].join("\n");

	test("captures only the marker's block", () => {
		assert.equal(
			countSection(doc, { section: "Project Name", sub: "Current Level" }),
			"seniorengineer".length,
		);
	});

	test("stops at next bold marker", () => {
		// Next Level block begins with a bold marker, ending Current Level capture
		assert.equal(
			countSection(doc, { section: "Project Name", sub: "Next Level" }),
			"staff".length,
		);
	});

	test("returns 0 when marker absent", () => {
		assert.equal(
			countSection(doc, { section: "Project Name", sub: "Missing" }),
			0,
		);
	});

	test("returns 0 when section absent (even with sub)", () => {
		assert.equal(
			countSection(doc, { section: "Nope", sub: "Current Level" }),
			0,
		);
	});
});

describe("formatResult", () => {
	test("no limit — prints bare count", () => {
		assert.deepEqual(formatResult(847), { ok: true, output: "847" });
	});
	test("within limit — prints ✓", () => {
		assert.deepEqual(formatResult(847, 1000), {
			ok: true,
			output: "847/1000 ✓",
		});
	});
	test("exactly at limit — ✓", () => {
		assert.deepEqual(formatResult(1000, 1000), {
			ok: true,
			output: "1000/1000 ✓",
		});
	});
	test("over limit — ✗ with overage", () => {
		assert.deepEqual(formatResult(847, 500), {
			ok: false,
			output: "847/500 ✗ (over by 347)",
		});
	});
});
