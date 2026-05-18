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
	parseInfraRootFilenames,
	isInfraFilename,
	isMarkdownFilename,
	collectOpenTasks,
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

describe("isMarkdownFilename", () => {
	test("accepts lowercase .md", () => {
		assert.equal(isMarkdownFilename("note.md"), true);
	});
	test("accepts uppercase .MD (case-insensitive filesystem reality)", () => {
		assert.equal(isMarkdownFilename("PROJECT.MD"), true);
	});
	test("accepts mixed-case .Md and .mD", () => {
		assert.equal(isMarkdownFilename("Daily.Md"), true);
		assert.equal(isMarkdownFilename("notes.mD"), true);
	});
	test("rejects non-markdown extensions", () => {
		assert.equal(isMarkdownFilename("note.txt"), false);
		assert.equal(isMarkdownFilename("note.markdown"), false);
		assert.equal(isMarkdownFilename("note.mdx"), false);
	});
	test("rejects bare names without an extension", () => {
		assert.equal(isMarkdownFilename(""), false);
		assert.equal(isMarkdownFilename("md"), false);
		assert.equal(isMarkdownFilename("note"), false);
	});
	test("rejects names where .md appears mid-string", () => {
		assert.equal(isMarkdownFilename("note.md.bak"), false);
		assert.equal(isMarkdownFilename(".mdrc"), false);
	});
});

describe("parseInfraRootFilenames", () => {
	test("returns empty when manifest is null", () => {
		assert.deepEqual(parseInfraRootFilenames(null), []);
	});
	test("returns empty when JSON is malformed", () => {
		assert.deepEqual(parseInfraRootFilenames("{ not json"), []);
	});
	test("returns empty when parsed value is not an object", () => {
		assert.deepEqual(parseInfraRootFilenames('"a string"'), []);
		assert.deepEqual(parseInfraRootFilenames("null"), []);
	});
	test("returns empty when infrastructure field is absent", () => {
		assert.deepEqual(parseInfraRootFilenames(JSON.stringify({})), []);
	});
	test("returns empty when infrastructure field is not an array", () => {
		assert.deepEqual(
			parseInfraRootFilenames(JSON.stringify({ infrastructure: "CLAUDE.md" })),
			[],
		);
	});
	test("returns only the root-level entries (filters out anything containing '/')", () => {
		const manifest = JSON.stringify({
			infrastructure: [
				"CLAUDE.md",
				"README.*.md",
				".claude/**",
				"templates/**",
				"Home.md",
			],
		});
		assert.deepEqual(parseInfraRootFilenames(manifest), [
			"CLAUDE.md",
			"README.*.md",
			"Home.md",
		]);
	});
	test("filters out non-string entries silently", () => {
		const manifest = JSON.stringify({
			infrastructure: ["CLAUDE.md", 42, null, "Home.md"],
		});
		assert.deepEqual(parseInfraRootFilenames(manifest), [
			"CLAUDE.md",
			"Home.md",
		]);
	});
});

describe("isInfraFilename", () => {
	// Mirrors the vault-manifest.json shape: literal entries for the canonical
	// names plus a glob for localized README variants. Both forms must work.
	const patterns = ["CLAUDE.md", "README.md", "README.*.md", "Home.md"];

	test("matches literal filenames exactly", () => {
		assert.equal(isInfraFilename("CLAUDE.md", patterns), true);
		assert.equal(isInfraFilename("README.md", patterns), true);
		assert.equal(isInfraFilename("Home.md", patterns), true);
	});
	test("rejects close-but-not-equal filenames", () => {
		assert.equal(isInfraFilename("claude.md", patterns), false); // case-sensitive
		assert.equal(isInfraFilename("CLAUDE.md.bak", patterns), false);
		assert.equal(isInfraFilename("MY-CLAUDE.md", patterns), false);
	});
	test("glob patterns match the localized variants they target", () => {
		assert.equal(isInfraFilename("README.ja.md", patterns), true);
		assert.equal(isInfraFilename("README.zh-CN.md", patterns), true);
	});
	test("bare * pattern matches every filename — documented footgun", () => {
		// If a user writes `"infrastructure": ["*"]` in vault-manifest.json,
		// every root-level file is treated as infra and openTasks empties out.
		// The behavior is "you asked, you get" — but locked here so a future
		// stricter parser doesn't silently regress this corner.
		assert.equal(isInfraFilename("anything.md", ["*"]), true);
		assert.equal(isInfraFilename("", ["*"]), true);
	});
	test("multiple wildcards in one pattern", () => {
		assert.equal(isInfraFilename("foo.bar.md", ["*.bar.*"]), true);
		assert.equal(isInfraFilename("foo.qux.md", ["*.bar.*"]), false);
	});
	test("escapes regex metacharacters in literal segments of patterns", () => {
		// `.` in `CLAUDE.md` must not match `CLAUDExmd`
		assert.equal(isInfraFilename("CLAUDExmd", patterns), false);
	});
	test("returns false on empty pattern list", () => {
		assert.equal(isInfraFilename("CLAUDE.md", []), false);
	});
	test("user content files are not infra", () => {
		assert.equal(isInfraFilename("2026-05-18.md", patterns), false);
		assert.equal(isInfraFilename("my-project.md", patterns), false);
	});
});

describe("collectOpenTasks", () => {
	test("aggregates tasks grouped by source, preserving input order", () => {
		const sources = [
			{ path: "work/active/a.md", content: "- [ ] task A1\n- [ ] task A2" },
			{ path: "work/active/b.md", content: "- [ ] task B1" },
		];
		assert.equal(
			collectOpenTasks(sources, 10),
			"work/active/a.md\n- [ ] task A1\n- [ ] task A2\n\nwork/active/b.md\n- [ ] task B1",
		);
	});
	test("skips sources with no unchecked tasks", () => {
		const sources = [
			{ path: "a.md", content: "# Heading\n\nprose only" },
			{ path: "b.md", content: "- [ ] real task" },
		];
		assert.equal(collectOpenTasks(sources, 10), "b.md\n- [ ] real task");
	});
	test("ignores checked tasks (both [x] and [X])", () => {
		const sources = [
			{
				path: "a.md",
				content: "- [ ] open\n- [x] done\n- [X] also done\n- [ ] still open",
			},
		];
		assert.equal(
			collectOpenTasks(sources, 10),
			"a.md\n- [ ] open\n- [ ] still open",
		);
	});
	test("preserves leading indentation on nested tasks", () => {
		const sources = [
			{ path: "a.md", content: "    - [ ] nested\n- [ ] top-level" },
		];
		assert.equal(
			collectOpenTasks(sources, 10),
			"a.md\n    - [ ] nested\n- [ ] top-level",
		);
	});
	test("handles CRLF line endings", () => {
		const sources = [{ path: "a.md", content: "- [ ] one\r\n- [ ] two\r\n" }];
		assert.equal(collectOpenTasks(sources, 10), "a.md\n- [ ] one\n- [ ] two");
	});
	test("respects the total limit across multiple sources", () => {
		const sources = [
			{ path: "a.md", content: "- [ ] a1\n- [ ] a2\n- [ ] a3" },
			{ path: "b.md", content: "- [ ] b1\n- [ ] b2" },
		];
		// limit 4: a1, a2, a3 from a.md (3); then 1 task from b.md
		assert.equal(
			collectOpenTasks(sources, 4),
			"a.md\n- [ ] a1\n- [ ] a2\n- [ ] a3\n\nb.md\n- [ ] b1",
		);
	});
	test("stops emitting groups once limit is fully consumed", () => {
		const sources = [
			{ path: "a.md", content: "- [ ] a1\n- [ ] a2" },
			{ path: "b.md", content: "- [ ] b1" },
		];
		assert.equal(collectOpenTasks(sources, 2), "a.md\n- [ ] a1\n- [ ] a2");
	});
	test("empty source list → '(no open tasks)'", () => {
		assert.equal(collectOpenTasks([], 10), "(no open tasks)");
	});
	test("all sources empty of tasks → '(no open tasks)'", () => {
		const sources = [
			{ path: "a.md", content: "# Heading\n\nprose" },
			{ path: "b.md", content: "- [x] done" },
		];
		assert.equal(collectOpenTasks(sources, 10), "(no open tasks)");
	});
	test("ignores non-task list items like bare bullets and starred lists", () => {
		const sources = [
			{
				path: "a.md",
				content: "- just a bullet\n- [ ] real task\n* [ ] not a dash",
			},
		];
		assert.equal(collectOpenTasks(sources, 10), "a.md\n- [ ] real task");
	});
	test("limit of 0 yields '(no open tasks)' even when sources are non-empty", () => {
		const sources = [{ path: "a.md", content: "- [ ] task one" }];
		assert.equal(collectOpenTasks(sources, 0), "(no open tasks)");
	});
	test("negative limit is treated like zero (no group ever emits)", () => {
		const sources = [{ path: "a.md", content: "- [ ] task one" }];
		assert.equal(collectOpenTasks(sources, -5), "(no open tasks)");
	});
	test("newlines in source path are escaped so they cannot corrupt the line-based output", () => {
		// readdirSync on POSIX can return filenames containing newlines; if such
		// a name reached the output unescaped, downstream parsers would split
		// the path across two lines and misattribute the following task.
		const sources = [
			{ path: "work/active/oops\nname.md", content: "- [ ] task one" },
		];
		assert.equal(
			collectOpenTasks(sources, 10),
			"work/active/oops\\nname.md\n- [ ] task one",
		);
	});
	test("carriage-return in source path is also escaped (Windows network shares)", () => {
		const sources = [
			{ path: "work/active/odd\rname.md", content: "- [ ] task one" },
		];
		assert.equal(
			collectOpenTasks(sources, 10),
			"work/active/odd\\nname.md\n- [ ] task one",
		);
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
