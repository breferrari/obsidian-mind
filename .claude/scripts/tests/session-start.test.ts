/**
 * Unit tests for session-start pure helpers.
 * The entry point itself (fs walk, git log, Obsidian CLI probe) is exercised
 * live when the hook fires; these tests lock the deterministic formatting
 * logic that doesn't need a real environment.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	take,
	formatDateHeader,
	formatActiveWork,
	formatRecentChanges,
	isSkippedPath,
	extractFrontmatterField,
	formatBrainIndex,
	stripFrontmatter,
	hasBrainContent,
	parseQmdIndex,
	qmdArgsWithIndex,
	isValidQmdIndex,
} from "../lib/session-start.ts";

describe("take", () => {
	test("keeps first N lines", () => {
		assert.equal(take("a\nb\nc\nd", 2), "a\nb");
	});
	test("N >= line count is a pass-through", () => {
		assert.equal(take("a\nb", 10), "a\nb");
	});
	test("empty string stays empty", () => {
		assert.equal(take("", 5), "");
	});
});

describe("formatDateHeader", () => {
	test("pads single-digit month and day; includes weekday", () => {
		const d = new Date(2026, 3, 5, 12, 0, 0); // April 5, 2026 (Sunday)
		assert.equal(formatDateHeader(d), "2026-04-05 (Sunday)");
	});
	test("double-digit components pass through", () => {
		const d = new Date(2026, 11, 25, 12, 0, 0); // December 25, 2026 (Friday)
		assert.equal(formatDateHeader(d), "2026-12-25 (Friday)");
	});
});

describe("formatActiveWork", () => {
	test("strips .md, respects limit, returns sorted input order", () => {
		const out = formatActiveWork(
			["project-a.md", "project-b.md", "project-c.md"],
			2,
		);
		assert.equal(out, "project-a\nproject-b");
	});
	test("filters out non-.md files", () => {
		const out = formatActiveWork(
			["a.md", "b.txt", "c.md", ".DS_Store"],
			10,
		);
		assert.equal(out, "a\nc");
	});
	test("empty input → '(none)'", () => {
		assert.equal(formatActiveWork([], 10), "(none)");
	});
	test("all-filtered-out → '(none)'", () => {
		assert.equal(formatActiveWork(["not-markdown.txt"], 10), "(none)");
	});
});

describe("formatRecentChanges", () => {
	test("filters blank lines, respects limit", () => {
		const out = formatRecentChanges("abc123 one\n\ndef456 two\n\nghi789 three", 2);
		assert.equal(out, "abc123 one\ndef456 two");
	});
	test("empty git output → '(no git history)'", () => {
		assert.equal(formatRecentChanges("", 15), "(no git history)");
	});
	test("whitespace-only git output → '(no git history)'", () => {
		assert.equal(formatRecentChanges("\n\n\n", 15), "(no git history)");
	});
});

describe("isSkippedPath", () => {
	const PREFIXES = [".git", ".obsidian", "thinking", ".claude"];

	test("exact prefix match is skipped", () => {
		assert.equal(isSkippedPath(".git", PREFIXES), true);
	});
	test("child of prefix is skipped", () => {
		assert.equal(isSkippedPath(".claude/commands/foo.md", PREFIXES), true);
	});
	test("segment-boundary enforcement — .github is NOT skipped under .git", () => {
		assert.equal(isSkippedPath(".github/workflow.md", PREFIXES), false);
	});
	test("unrelated path is not skipped", () => {
		assert.equal(isSkippedPath("work/active/note.md", PREFIXES), false);
	});
	test("empty prefix list never skips", () => {
		assert.equal(isSkippedPath(".git/foo", []), false);
	});
});

describe("extractFrontmatterField", () => {
	test("extracts double-quoted string value", () => {
		const content = '---\ndescription: "hello world"\ntags:\n  - brain\n---\n\n# body';
		assert.equal(extractFrontmatterField(content, "description"), "hello world");
	});
	test("extracts single-quoted string value", () => {
		const content = "---\ndescription: 'hi there'\n---\n";
		assert.equal(extractFrontmatterField(content, "description"), "hi there");
	});
	test("extracts bare value", () => {
		const content = "---\ndescription: bare text here\ntags:\n  - brain\n---\n";
		assert.equal(extractFrontmatterField(content, "description"), "bare text here");
	});
	test("returns null when field is present but empty", () => {
		const content = "---\ndate:\ndescription: \"x\"\n---\n";
		assert.equal(extractFrontmatterField(content, "date"), null);
	});
	test("returns null when field is absent", () => {
		const content = "---\ntags:\n  - brain\n---\n";
		assert.equal(extractFrontmatterField(content, "description"), null);
	});
	test("returns null when content has no frontmatter", () => {
		assert.equal(extractFrontmatterField("# just a heading\n\nbody", "description"), null);
	});
	test("returns null when frontmatter is unterminated", () => {
		assert.equal(extractFrontmatterField("---\ndescription: \"x\"\n", "description"), null);
	});
	test("ignores matches that appear only in the body", () => {
		const content = "---\ntags: []\n---\n\ndescription: not frontmatter\n";
		assert.equal(extractFrontmatterField(content, "description"), null);
	});
	test("handles CRLF line endings (Windows)", () => {
		const content = '---\r\ndescription: "hello"\r\ntags: []\r\n---\r\n# body';
		assert.equal(extractFrontmatterField(content, "description"), "hello");
	});
	test("does not mistake body line starting with --- for frontmatter terminator", () => {
		const content =
			'---\ndescription: "real"\n---\n\n---this-is-not-a-delimiter\n';
		assert.equal(extractFrontmatterField(content, "description"), "real");
	});
	test("escapes regex metacharacters in field name", () => {
		const content = "---\nfoo.bar: actual-value\n---\n";
		assert.equal(extractFrontmatterField(content, "foo.bar"), "actual-value");
		// An unescaped `.` would have matched `fooxbar:` — confirm it doesn't.
		const decoy = "---\nfooxbar: decoy\n---\n";
		assert.equal(extractFrontmatterField(decoy, "foo.bar"), null);
	});
});

describe("stripFrontmatter", () => {
	test("removes a complete frontmatter block", () => {
		const out = stripFrontmatter("---\ntags: []\n---\n\n# body\n");
		assert.equal(out, "\n# body\n");
	});
	test("leaves content without frontmatter unchanged", () => {
		assert.equal(stripFrontmatter("# just a heading\n"), "# just a heading\n");
	});
	test("leaves unterminated frontmatter unchanged", () => {
		const content = "---\ntags: []\n# never closed\n";
		assert.equal(stripFrontmatter(content), content);
	});
	test("handles CRLF line endings", () => {
		const out = stripFrontmatter("---\r\ntags: []\r\n---\r\n# body\r\n");
		assert.equal(out, "# body\r\n");
	});
	test("does not mistake body line starting with --- for terminator", () => {
		const content = "---\ntags: []\n---\n\n---this-is-body\n";
		assert.equal(stripFrontmatter(content), "\n---this-is-body\n");
	});
});

describe("hasBrainContent", () => {
	test("false when only a bare-hyphen placeholder exists", () => {
		assert.equal(hasBrainContent("\n# Gotchas\n\nSome intro.\n\n-\n"), false);
	});
	test("true for a bullet with text", () => {
		assert.equal(hasBrainContent("- first real gotcha\n"), true);
	});
	test("true for indented bullets", () => {
		assert.equal(hasBrainContent("  - nested item\n"), true);
	});
	test("true for asterisk and plus markers", () => {
		assert.equal(hasBrainContent("* item\n"), true);
		assert.equal(hasBrainContent("+ item\n"), true);
	});
	test("false for empty body", () => {
		assert.equal(hasBrainContent(""), false);
	});
	test("false for prose-only content with no bullets", () => {
		assert.equal(hasBrainContent("Just a paragraph of prose.\n"), false);
	});
});

describe("parseQmdIndex", () => {
	test("extracts qmd_index when present as a non-empty string", () => {
		const manifest = JSON.stringify({ qmd_index: "obsidian-mind" });
		assert.equal(parseQmdIndex(manifest), "obsidian-mind");
	});
	test("returns null when qmd_index is an empty string", () => {
		const manifest = JSON.stringify({ qmd_index: "" });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when qmd_index is missing from the manifest", () => {
		const manifest = JSON.stringify({ template: "obsidian-mind" });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when qmd_index is not a string", () => {
		const manifest = JSON.stringify({ qmd_index: 42 });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when the manifest source is null (missing file)", () => {
		assert.equal(parseQmdIndex(null), null);
	});
	test("returns null when the manifest is malformed JSON", () => {
		assert.equal(parseQmdIndex("{ not json"), null);
	});
	test("returns null when the manifest parses to a non-object", () => {
		assert.equal(parseQmdIndex('"just a string"'), null);
	});
	test("returns null when qmd_index contains a forward-slash path separator", () => {
		const manifest = JSON.stringify({ qmd_index: "vault/subdir" });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when qmd_index contains a backslash path separator", () => {
		const manifest = JSON.stringify({ qmd_index: "vault\\subdir" });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when qmd_index is a parent-dir escape attempt", () => {
		const manifest = JSON.stringify({ qmd_index: "../../etc/passwd" });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when qmd_index contains whitespace", () => {
		const manifest = JSON.stringify({ qmd_index: "my vault" });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when qmd_index is whitespace-only", () => {
		const manifest = JSON.stringify({ qmd_index: "   " });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("returns null when qmd_index starts with a non-alphanumeric character", () => {
		const manifest = JSON.stringify({ qmd_index: "-leading-dash" });
		assert.equal(parseQmdIndex(manifest), null);
	});
	test("accepts dash, dot, and underscore inside the name", () => {
		const manifest = JSON.stringify({ qmd_index: "vault-a_b.2" });
		assert.equal(parseQmdIndex(manifest), "vault-a_b.2");
	});
});

describe("isValidQmdIndex", () => {
	test("accepts standard names", () => {
		assert.equal(isValidQmdIndex("obsidian-mind"), true);
		assert.equal(isValidQmdIndex("vigil"), true);
		assert.equal(isValidQmdIndex("vault.2_final"), true);
	});
	test("rejects path separators, whitespace, empty, and leading punctuation", () => {
		assert.equal(isValidQmdIndex(""), false);
		assert.equal(isValidQmdIndex(" "), false);
		assert.equal(isValidQmdIndex("a b"), false);
		assert.equal(isValidQmdIndex("a/b"), false);
		assert.equal(isValidQmdIndex("a\\b"), false);
		assert.equal(isValidQmdIndex("../x"), false);
		assert.equal(isValidQmdIndex("-leading"), false);
		assert.equal(isValidQmdIndex(".leading"), false);
	});
	test("rejects non-string values", () => {
		assert.equal(isValidQmdIndex(undefined), false);
		assert.equal(isValidQmdIndex(null), false);
		assert.equal(isValidQmdIndex(42), false);
		assert.equal(isValidQmdIndex({}), false);
	});
});

describe("qmdArgsWithIndex", () => {
	test("prepends --index <name> when an index is provided", () => {
		assert.deepEqual(qmdArgsWithIndex("obsidian-mind", ["update"]), [
			"--index",
			"obsidian-mind",
			"update",
		]);
	});
	test("returns subcommand args unchanged when index is null", () => {
		assert.deepEqual(qmdArgsWithIndex(null, ["update"]), ["update"]);
	});
	test("preserves multi-arg subcommand invocations", () => {
		assert.deepEqual(
			qmdArgsWithIndex("vault", ["query", "ShardMind", "--json"]),
			["--index", "vault", "query", "ShardMind", "--json"],
		);
	});
	test("returns a fresh array (does not mutate the input)", () => {
		const input = ["update"];
		const out = qmdArgsWithIndex(null, input);
		assert.notEqual(out, input);
		assert.deepEqual(out, input);
	});
});

describe("formatBrainIndex", () => {
	test("renders one wikilink + description per entry", () => {
		const out = formatBrainIndex([
			{ name: "Patterns", description: "recurring patterns", hasContent: true },
			{ name: "Gotchas", description: "things that bite", hasContent: true },
		]);
		assert.equal(
			out,
			"- [[Patterns]] — recurring patterns\n- [[Gotchas]] — things that bite",
		);
	});
	test("appends '(empty)' for stub notes", () => {
		const out = formatBrainIndex([
			{ name: "Gotchas", description: "things that bite", hasContent: false },
		]);
		assert.equal(out, "- [[Gotchas]] — things that bite (empty)");
	});
	test("skips North Star and Memories (already surfaced elsewhere)", () => {
		const out = formatBrainIndex([
			{ name: "North Star", description: "goals", hasContent: true },
			{ name: "Memories", description: "index", hasContent: true },
			{ name: "Patterns", description: "patterns", hasContent: true },
		]);
		assert.equal(out, "- [[Patterns]] — patterns");
	});
	test("falls back to '(no description)' for null description", () => {
		const out = formatBrainIndex([
			{ name: "Patterns", description: null, hasContent: true },
		]);
		assert.equal(out, "- [[Patterns]] — (no description)");
	});
	test("empty input → '(none)'", () => {
		assert.equal(formatBrainIndex([]), "(none)");
	});
	test("all-filtered-out → '(none)'", () => {
		const out = formatBrainIndex([
			{ name: "North Star", description: "x", hasContent: true },
			{ name: "Memories", description: "y", hasContent: true },
		]);
		assert.equal(out, "(none)");
	});
});
