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
