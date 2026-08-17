/**
 * Unit tests for lib/wikilinks.ts — the parser + resolver behind the
 * vault's broken-link zero gate. Fixture strings only; the real-vault
 * scan lives in vault-wikilinks.test.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	stripCodeRegions,
	extractWikilinkTargets,
	extractAliases,
	buildResolver,
} from "../lib/wikilinks.ts";

describe("stripCodeRegions", () => {
	test("removes fenced blocks including their wikilinks", () => {
		const md = "before\n```md\n[[Fenced Link]]\n```\nafter";
		const out = stripCodeRegions(md);
		assert.ok(!out.includes("Fenced Link"));
		assert.ok(out.includes("before"));
		assert.ok(out.includes("after"));
	});
	test("removes tilde fences", () => {
		assert.ok(
			!stripCodeRegions("~~~\n[[X]]\n~~~").includes("X"),
		);
	});
	test("unclosed fence strips to EOF", () => {
		assert.ok(!stripCodeRegions("```\n[[X]]\n[[Y]]").includes("[["));
	});
	test("removes inline code spans, keeps surrounding text", () => {
		const out = stripCodeRegions("use `[[wikilinks]]` for links to [[Real]]");
		assert.ok(!out.includes("wikilinks"));
		assert.ok(out.includes("[[Real]]"));
	});
	test("removes multi-backtick code spans (CommonMark N-closes-N)", () => {
		const out = stripCodeRegions(
			"double ``[[Not A Link]]`` and triple ```[[Also Not]]``` beside [[Real]]",
		);
		assert.ok(!out.includes("Not A Link"));
		assert.ok(!out.includes("Also Not"));
		assert.ok(out.includes("[[Real]]"));
	});
	test("spans containing lone backticks strip whole (`` x ` y ``)", () => {
		const out = stripCodeRegions("odd ``code with ` inside`` then [[Real]]");
		assert.ok(out.includes("[[Real]]"));
		assert.ok(!out.includes("code with"));
	});
});

describe("extractWikilinkTargets", () => {
	test("plain link", () => {
		assert.deepEqual(extractWikilinkTargets("see [[North Star]]"), [
			"North Star",
		]);
	});
	test("alias tail stripped", () => {
		assert.deepEqual(extractWikilinkTargets("[[North Star|goals]]"), [
			"North Star",
		]);
	});
	test("table-escaped alias pipe stripped (no trailing backslash)", () => {
		assert.deepEqual(
			extractWikilinkTargets("| [[North Star\\|goals]] |"),
			["North Star"],
		);
	});
	test("embed prefix accepted", () => {
		assert.deepEqual(extractWikilinkTargets("![[North Star]]"), [
			"North Star",
		]);
	});
	test("heading and block fragments stripped", () => {
		assert.deepEqual(
			extractWikilinkTargets("[[North Star#Goals]] and [[Note#^abc123]]"),
			["North Star", "Note"],
		);
	});
	test("same-file heading link is not a target", () => {
		assert.deepEqual(extractWikilinkTargets("[[#Local Section]]"), []);
	});
	test("template placeholders ignored", () => {
		assert.deepEqual(extractWikilinkTargets("[[{{project}}]]"), []);
	});
	test("asset embeds ignored, note-like dots kept", () => {
		assert.deepEqual(
			extractWikilinkTargets(
				"![[chart.png]] [[Dashboard.base]] [[example.com Analytics]]",
			),
			["example.com Analytics"],
		);
	});
	test("relative path target preserved", () => {
		assert.deepEqual(extractWikilinkTargets("[[../personas]]"), [
			"../personas",
		]);
	});
});

describe("extractAliases", () => {
	test("block list form", () => {
		const md = '---\ndate: 2026-01-01\naliases:\n  - Soul\n  - "Vigil"\n---\nbody';
		assert.deepEqual(extractAliases(md), ["Soul", "Vigil"]);
	});
	test("inline array form", () => {
		const md = "---\naliases: [obsidian-mind, 'OM']\n---\n";
		assert.deepEqual(extractAliases(md), ["obsidian-mind", "OM"]);
	});
	test("no frontmatter / no aliases → empty", () => {
		assert.deepEqual(extractAliases("# Title"), []);
		assert.deepEqual(extractAliases("---\ndate: x\n---\n"), []);
	});
	test("block list ends at next scalar field", () => {
		const md = "---\naliases:\n  - One\ntags:\n  - brain\n---\n";
		assert.deepEqual(extractAliases(md), ["One"]);
	});
	test("single-quoted alias unescapes YAML's doubled apostrophe", () => {
		const md = "---\naliases:\n  - 'the writer''s two facts'\n---\n";
		assert.deepEqual(extractAliases(md), ["the writer's two facts"]);
	});
	test("inline array form unescapes it too", () => {
		const md = "---\naliases: ['Sarah''s 1:1', Plain]\n---\n";
		assert.deepEqual(extractAliases(md), ["Sarah's 1:1", "Plain"]);
	});
	test("double-quoted alias keeps a bare apostrophe unchanged", () => {
		const md = "---\naliases:\n  - \"the writer's two facts\"\n---\n";
		assert.deepEqual(extractAliases(md), ["the writer's two facts"]);
	});
	test("a lone apostrophe is not a quote pair", () => {
		const md = "---\naliases:\n  - '\n---\n";
		assert.deepEqual(extractAliases(md), ["'"]);
	});

	// The other half of the same defect: single-quoted YAML escapes by doubling,
	// double-quoted escapes with a backslash, and stripping either charwise
	// yields a name no wikilink can cite.
	test("double-quoted alias unescapes a backslash-escaped quote", () => {
		const md = '---\naliases:\n  - "the \\"good\\" parts"\n---\n';
		assert.deepEqual(extractAliases(md), ['the "good" parts']);
	});
	test("inline array form unescapes the backslash form too", () => {
		const md = '---\naliases: ["a \\"quoted\\" name", Plain]\n---\n';
		assert.deepEqual(extractAliases(md), ['a "quoted" name', "Plain"]);
	});
	test("an escaped backslash survives as one backslash", () => {
		const md = '---\naliases:\n  - "a \\\\ b"\n---\n';
		assert.deepEqual(extractAliases(md), ["a \\ b"]);
	});
	// Regression guard on the branch being edited rather than a demonstration of
	// the bug: this passed before and must keep passing.
	test("a double-quoted alias with no escapes is unchanged", () => {
		const md = "---\naliases:\n  - \"the writer's two facts\"\n---\n";
		assert.deepEqual(extractAliases(md), ["the writer's two facts"]);
	});
});

describe("buildResolver", () => {
	const files = [
		"brain/North Star.md",
		"projects/obsidian-mind/README.md",
		"reference/cv-system/tracks/apple-audio.md",
		"work/career/inbound-recruiter-log.md",
	];
	const aliases = new Map<string, readonly string[]>([
		["projects/obsidian-mind/README.md", ["obsidian-mind"]],
		["work/career/inbound-recruiter-log.md", ["Inbound Recruiter Log"]],
	]);
	const resolves = buildResolver(files, aliases);

	test("basename match, case-insensitive", () => {
		assert.ok(resolves("North Star", "Home.md"));
		assert.ok(resolves("north star", "Home.md"));
	});
	test("alias match", () => {
		assert.ok(resolves("obsidian-mind", "Home.md"));
		assert.ok(resolves("inbound recruiter log", "Home.md"));
	});
	test("path suffix match", () => {
		assert.ok(resolves("obsidian-mind/README", "Home.md"));
		assert.ok(resolves("projects/obsidian-mind/README", "Home.md"));
	});
	test("relative target resolves against source dir", () => {
		assert.ok(
			resolves("../tracks/apple-audio", "reference/cv-system/regions/de.md"),
		);
		assert.ok(
			!resolves(
				"../../tracks/apple-audio",
				"reference/cv-system/regions/de.md",
			),
			"one ../ too many must NOT resolve",
		);
	});
	test("relative target escaping the vault root does not resolve", () => {
		assert.ok(!resolves("../../../../etc/passwd", "brain/North Star.md"));
	});
	test("unknown name does not resolve", () => {
		assert.ok(!resolves("Nonexistent Note", "Home.md"));
	});
	test("explicit .md extension accepted", () => {
		assert.ok(resolves("North Star.md", "Home.md"));
	});
});

describe("extractWikilinkTargets — parser gaps found in the field (2026-07-14)", () => {
	test("HTML-entity escaped pipe (&#124;) in tables", () => {
		assert.deepEqual(
			extractWikilinkTargets("| [[North Star&#124;goals]] |"),
			["North Star"],
		);
	});
	test("html artifact targets are not note edges", () => {
		assert.deepEqual(
			extractWikilinkTargets("[[2026-01-01 Briefing (Thing).html]]"),
			[],
		);
	});
});

/**
 * Shapes the alias reader met in the field and misread. Each cost the WHOLE
 * alias set or a whole entry, and each surfaced as a broken-link report against
 * a note whose alias is plainly there — a zero gate red for a reason no author
 * can act on.
 */
describe("extractAliases — ordinary YAML the reader used to lose", () => {
	const crlf = (...lines: string[]): string => lines.join("\r\n");

	// Obsidian-on-Windows rewrites LF to CRLF on edit; .gitattributes exists
	// because of it, and normalizes what enters a commit, not what is on disk
	// while the gate walks the working tree.
	test("a CRLF note keeps its aliases", () => {
		const md = crlf("---", "aliases:", "  - One", "  - Two", "---", "body", "");
		assert.deepEqual(extractAliases(md), ["One", "Two"]);
	});

	// Item one is where it broke, so a single-alias note pins the total failure
	// rather than a truncation that happens to look similar.
	test("a CRLF note with one alias keeps it", () => {
		assert.deepEqual(extractAliases(crlf("---", "aliases:", "  - Only", "---", "b", "")), ["Only"]);
	});

	test("an LF note is unaffected by the normalization", () => {
		const md = "---\naliases:\n  - One\n  - Two\n---\nbody\n";
		assert.deepEqual(extractAliases(md), ["One", "Two"]);
	});

	test("a comma inside a quoted alias is content, not a separator", () => {
		const md = '---\naliases: ["Smith, John", Nickname]\n---\n';
		assert.deepEqual(extractAliases(md), ["Smith, John", "Nickname"]);
	});

	test("a trailing YAML comment does not empty an inline array", () => {
		assert.deepEqual(extractAliases("---\naliases: [One, Two] # my aliases\n---\n"), ["One", "Two"]);
	});

	test("a blank line between block entries does not end the list", () => {
		assert.deepEqual(extractAliases("---\naliases:\n  - One\n\n  - Two\n---\n"), ["One", "Two"]);
	});

	test("a comment between block entries does not end the list", () => {
		assert.deepEqual(extractAliases("---\naliases:\n  - One\n  # note\n  - Two\n---\n"), ["One", "Two"]);
	});

	// The blank/comment tolerance must not swallow the terminator it was added
	// beside: a real key still ends the sequence.
	test("a following scalar key still ends the list", () => {
		assert.deepEqual(extractAliases("---\naliases:\n  - One\n\ntags:\n  - brain\n---\n"), ["One"]);
	});
});
