/**
 * The hard-wrap detector (#247). Each structure case below was found by
 * damage when wrapped prose was joined in bulk: joining any of them loses no
 * word, so only a detector that knows structure can leave them alone.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hardWrappedParagraphs, isVerbatim } from "../lib/prose-width.ts";

const at = (...lines: string[]) => hardWrappedParagraphs(lines.join("\n"));

describe("hardWrappedParagraphs — prose", () => {
	test("a paragraph continued onto the next line is reported at the continuation", () => {
		assert.deepEqual(at("# T", "", "A paragraph that was", "wrapped at a narrow width,", "twice."), [4, 5]);
	});
	test("one line per paragraph is clean", () => {
		assert.deepEqual(at("# T", "", "One paragraph on one line.", "", "Another, also on one."), []);
	});
	test("a wrapped paragraph inside a blockquote counts; the marker is not prose", () => {
		assert.deepEqual(at("> A quoted paragraph that", "> was wrapped."), [2]);
	});
	test("line numbers are of the file, frontmatter included", () => {
		assert.deepEqual(at("---", "date: x", "---", "first", "second"), [5]);
	});
});

describe("hardWrappedParagraphs — structure is never counted", () => {
	const clean: [string, string[]][] = [
		["LF frontmatter", ["---", "name: a", "description: b", "---", "Body."]],
		["fenced code with backticks", ["```", "line one", "line two", "```"]],
		["fenced code with tildes", ["~~~", "line one", "line two", "~~~"]],
		["an HTML comment", ["<!--", "Terminal and version:", "OS:", "-->"]],
		["raw HTML", ["<table>", "<tr><td>a</td></tr>", "</table>"]],
		["an Obsidian %% comment", ["%%", "private line", "another", "%%"]],
		["$$ math", ["$$", "a = b", "c = d", "$$"]],
		["a table", ["| a | b |", "|---|---|", "| 1 | 2 |"]],
		["tab-separated rows", ["name\tvalue", "alpha\t1", "beta\t2"]],
		["headings", ["# One", "## Two"]],
		["list items and bare markers", ["- one", "- two", "1.", "-"]],
		["indented lines: code, or a list item's continuation", ["- item", "  source: x", "  notes: y", "    code line", "    code line"]],
		["field lines, both bold forms", ["**Door:** two-way.", "**Blast radius**: small."]],
		["embeds", ["![[Note]]", "![[Other]]"]],
		["a callout title above its body", ["> [!warning] Title", "> Body on one line."]],
		["an explicit hard break (two spaces)", ["Line one  ", "line two"]],
		["an explicit hard break (backslash)", ["Line one\\", "line two"]],
		["a lead-in ending in a colon", ["Content to process:", "$ARGUMENTS"]],
		["a thematic break", ["Text.", "---", "More."]],
		["a fence inside a blockquote", ["> Run this:", "> ```sh", "> one", "> two", "> ```"]],
		["prose, then a blockquote: two blocks", ["**A question?**", "> An answer on one line.", "Back in prose."]],
		["bold-led items, one per line", ["**1. First question?** Detail.", "**2. Second question?** More."]],
	];
	for (const [name, lines] of clean) {
		test(name, () => assert.deepEqual(at(...lines), []));
	}

	test("CRLF frontmatter is found as frontmatter, not read as wrapped fields", () => {
		assert.deepEqual(hardWrappedParagraphs("---\r\nname: a\r\ndescription: b\r\n---\r\nBody.\r\n"), []);
	});
	test("CRLF prose is still prose", () => {
		assert.deepEqual(hardWrappedParagraphs("A paragraph\r\nwrapped.\r\n"), [2]);
	});
	test("prose resumes being checked after a fence closes", () => {
		assert.deepEqual(at("```", "x", "```", "Prose that", "wraps."), [5]);
	});
});

describe("verbatim opt-out", () => {
	test("`verbatim: true` in frontmatter keeps a raw capture's breaks", () => {
		const note = "---\nverbatim: true\n---\nA pasted log\nwith its own\nline breaks.";
		assert.equal(isVerbatim(note), true);
		assert.deepEqual(hardWrappedParagraphs(note), []);
	});
	test("verbatim outside frontmatter, or false, does not opt out", () => {
		assert.equal(isVerbatim("verbatim: true\nA\nB"), false);
		assert.equal(isVerbatim("---\nverbatim: false\n---\nA\nB"), false);
	});
});
