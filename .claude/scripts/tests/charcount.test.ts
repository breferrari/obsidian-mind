/**
 * Unit tests for charcount section extraction and result formatting.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countSection, formatResult } from "../lib/charcount.ts";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = join(SCRIPTS, "..", "..");

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

	test("returns null for a missing section, never 0", () => {
		assert.equal(countSection(doc, { section: "Nope" }), null);
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

	test("returns null when marker absent", () => {
		assert.equal(
			countSection(doc, { section: "Project Name", sub: "Missing" }),
			null,
		);
	});

	test("returns null when section absent (even with sub)", () => {
		assert.equal(
			countSection(doc, { section: "Nope", sub: "Current Level" }),
			null,
		);
	});
});

/**
 * The review template writes its sections as `##` headings with a suffix
 * (`## Impact -- "What was delivered?"`). A `###`-only matcher found none of
 * them, counted 0, and every limit check passed on text it never read.
 */
describe("countSection — ## sections and heading names", () => {
	test("counts a ## section", () => {
		const d = ["## Summary", "abcdefghij", "## Next"].join("\n");
		assert.equal(countSection(d, { section: "Summary" }), 10);
	});

	test("a ## section keeps its ### children and stops at the next ##", () => {
		const d = ["## Impact", "ab", "### Detail", "cd", "## Growth", "zz"].join("\n");
		assert.equal(countSection(d, { section: "Impact" }), "ab### Detailcd".length);
	});

	test("a ### section stops at a heading of any higher level", () => {
		const d = ["### A", "ab", "# Top", "zz"].join("\n");
		assert.equal(countSection(d, { section: "A" }), 2);
	});

	test("name followed by a separator suffix matches", () => {
		const d = ['## Impact -- "What was delivered?"', "abc", "## Next"].join("\n");
		assert.equal(countSection(d, { section: "Impact" }), 3);
	});

	test("a longer word is a different section", () => {
		const d = ["### Impact Summary", "abc"].join("\n");
		assert.equal(countSection(d, { section: "Impact" }), null);
	});

	test("a deeper heading does not open the section", () => {
		const d = ["#### Impact", "abc"].join("\n");
		assert.equal(countSection(d, { section: "Impact" }), null);
	});

	test("an exact heading wins over an earlier suffixed one", () => {
		const d = ["## Impact -- intro", "aaaa", "## Impact", "bb"].join("\n");
		assert.equal(countSection(d, { section: "Impact" }), 2);
	});

	test("CRLF files match and the carriage returns are not counted", () => {
		const d = ["## Summary", "abc", "## Next"].join("\r\n");
		assert.equal(countSection(d, { section: "Summary" }), 3);
	});

	test("every section heading in the shipped review template is found", () => {
		const tpl = readFileSync(join(VAULT, "templates", "Review Template.md"), "utf-8");
		for (const s of ["Summary", "Impact", "Competencies", "Principles", "Growth Plan"]) {
			assert.notEqual(countSection(tpl, { section: s }), null, s);
		}
	});
});

describe("charcount CLI", () => {
	function run(body: string, ...args: string[]) {
		const dir = mkdtempSync(join(tmpdir(), "charcount-"));
		try {
			const file = join(dir, "review.md");
			writeFileSync(file, body);
			return spawnSync(
				process.execPath,
				[
					"--disable-warning=ExperimentalWarning",
					"--experimental-strip-types",
					join(SCRIPTS, "charcount.ts"),
					file,
					...args,
				],
				{ encoding: "utf-8" },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("a ## section over its limit fails", () => {
		const r = run("## Summary\nabcdefghij\n", "Summary", "", "5");
		assert.equal(r.status, 1);
		assert.equal(r.stdout.trim(), "10/5 ✗ (over by 5)");
	});

	test("a missing section exits 2 and prints no count", () => {
		const r = run("## Summary\nabc\n", "Nope", "", "5");
		assert.equal(r.status, 2);
		assert.equal(r.stdout, "");
		assert.match(r.stderr, /Section not found: "Nope"/);
	});

	test("a missing sub-marker exits 2", () => {
		const r = run("### Project\n**Current Level:**\nx\n", "Project", "Next Level", "5");
		assert.equal(r.status, 2);
		assert.match(r.stderr, /Marker not found/);
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
