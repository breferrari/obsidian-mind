/**
 * Unit tests for frontmatter module — skip rules and content validation.
 * Complements validate-write integration tests by testing the logic directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isBlockedMemoryPath,
	noteTypeForPath,
	parseFrontmatterRequired,
	readFrontmatterKeys,
	shouldSkipFile,
	validateContent,
} from "../lib/frontmatter.ts";

const VAULT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * `frontmatter_required` was declared in the manifest and documented as the
 * place to add a note type, but no hook read it: the validator hardcoded
 * three fields. These drive it from the declaration.
 */
describe("validateContent — frontmatter_required drives the check", () => {
	const REQUIRED = parseFrontmatterRequired({
		frontmatter_required: {
			global: ["date", "description", "tags"],
			"work-note": ["date", "status", "quarter"],
			incident: ["date", "status", "quarter", "ticket", "severity", "role"],
			person: ["date", "title"],
			"1-1": ["date", "quarter"],
		},
	});
	const note = (fm: string) => `---\n${fm}\n---\nShort.`;
	const base = "date: 2026-01-01\ndescription: d\ntags:\n  - x";
	const missing = (w: string[]) =>
		w.map((x) => /Missing `([^`]+)`/.exec(x)?.[1]).filter(Boolean).sort();

	test("a work note must carry the work-note set", () => {
		const w = validateContent(note(base), { required: REQUIRED, relPath: "work/active/A.md" });
		assert.deepEqual(missing(w), ["quarter", "status"]);
	});

	test("an archived work note too", () => {
		const w = validateContent(note(`${base}\nstatus: completed\nquarter: Q1-2026`), {
			required: REQUIRED,
			relPath: "work/archive/2026/A.md",
		});
		assert.deepEqual(w, []);
	});

	test("a 1:1 note needs quarter but not a work note's status, though it is tagged work-note", () => {
		const w = validateContent(note("date: 2026-01-01\ndescription: d\ntags:\n  - work-note"), {
			required: REQUIRED,
			relPath: "work/1-1/Alex 2026-01-01.md",
		});
		assert.deepEqual(missing(w), ["quarter"]);
	});

	test("a main incident note (tagged incident) needs the incident set", () => {
		const w = validateContent(note("date: 2026-01-01\ndescription: d\ntags: [work-note, incident]\nstatus: open\nquarter: Q1-2026"), {
			required: REQUIRED,
			relPath: "work/incidents/INC-1.md",
		});
		assert.deepEqual(missing(w), ["role", "severity", "ticket"]);
	});

	test("an incident satellite (not tagged incident) carries the global set alone", () => {
		const w = validateContent(note(`${base}`), {
			required: REQUIRED,
			relPath: "work/incidents/INC-1 RCA.md",
		});
		assert.deepEqual(w, []);
	});

	test("a person note needs title", () => {
		const w = validateContent(note(base), { required: REQUIRED, relPath: "org/people/Alex Doe.md" });
		assert.deepEqual(missing(w), ["title"]);
	});

	test("a note outside the typed folders gets the global set only", () => {
		assert.deepEqual(validateContent(note(base), { required: REQUIRED, relPath: "brain/Patterns.md" }), []);
	});

	test("a custom global set replaces the built-in three", () => {
		const w = validateContent(note("date: 2026-01-01"), {
			required: parseFrontmatterRequired({ frontmatter_required: { global: ["date", "owner"] } }),
			relPath: "brain/X.md",
		});
		assert.deepEqual(missing(w), ["owner"]);
	});

	test("no frontmatter_required → the built-in three, as before", () => {
		const w = validateContent(note("date: 2026-01-01"), { required: {}, relPath: "work/active/A.md" });
		assert.deepEqual(missing(w), ["description", "tags"]);
	});

	test("`update:` does not satisfy `date`", () => {
		const w = validateContent(note("update: 2026-01-01\ndescription: d\ntags: [x]"));
		assert.deepEqual(missing(w), ["date"]);
	});

	test("a key nested under another does not count", () => {
		const w = validateContent(note("description: d\ntags: [x]\nmeta:\n  date: 2026-01-01"));
		assert.deepEqual(missing(w), ["date"]);
	});

	test("the shipped Work Note template declares every field the shipped manifest requires of a work note", () => {
		const manifest = JSON.parse(readFileSync(join(VAULT, "vault-manifest.json"), "utf-8"));
		const tpl = readFileSync(join(VAULT, "templates", "Work Note.md"), "utf-8");
		const w = validateContent(tpl, { required: parseFrontmatterRequired(manifest), relPath: "work/active/New.md" });
		assert.deepEqual(missing(w), [], w.join("\n"));
	});
});

describe("readFrontmatterKeys and noteTypeForPath", () => {
	test("tags as a block list, an inline list, or a scalar", () => {
		assert.deepEqual(readFrontmatterKeys("tags:\n  - a\n  - \"b\"\ndate: x").tags, ["a", "b"]);
		assert.deepEqual(readFrontmatterKeys("tags: [a, 'b']").tags, ["a", "b"]);
		assert.deepEqual(readFrontmatterKeys("tags: a").tags, ["a"]);
	});
	test("a list item after another key is not a tag", () => {
		assert.deepEqual(readFrontmatterKeys("tags:\n  - a\naliases:\n  - b").tags, ["a"]);
	});
	test("folder → type, with Windows separators", () => {
		assert.equal(noteTypeForPath("work\\incidents\\X.md"), "incident");
		assert.equal(noteTypeForPath("org/teams/Core.md"), "team");
		assert.equal(noteTypeForPath("thinking/x.md"), null);
	});
});

describe("shouldSkipFile — skip rules", () => {
	test("skips non-markdown", () => {
		assert.equal(shouldSkipFile("/tmp/test.txt"), true);
	});
	test("skips empty path", () => {
		assert.equal(shouldSkipFile(""), true);
	});
	test("skips README.md", () => {
		assert.equal(shouldSkipFile("/some/path/README.md"), true);
	});
	test("skips translated READMEs", () => {
		for (const lang of ["ja", "ko", "zh-CN"]) {
			assert.equal(shouldSkipFile(`/some/path/README.${lang}.md`), true);
		}
	});
	test("skips CHANGELOG.md", () => {
		assert.equal(shouldSkipFile("/some/path/CHANGELOG.md"), true);
	});
	test("skips CLAUDE / AGENTS / GEMINI / CONTRIBUTING / ARCHITECTURE", () => {
		for (const f of [
			"CLAUDE.md",
			"AGENTS.md",
			"GEMINI.md",
			"CONTRIBUTING.md",
			"ARCHITECTURE.md",
		]) {
			assert.equal(shouldSkipFile(`/vault/${f}`), true);
		}
	});
	test("skips .claude/ paths", () => {
		assert.equal(shouldSkipFile("/vault/.claude/commands/foo.md"), true);
	});
	test("skips .codex/ paths", () => {
		assert.equal(shouldSkipFile("/vault/.codex/hooks.json.md"), true);
	});
	test("skips .gemini/ paths", () => {
		assert.equal(shouldSkipFile("/vault/.gemini/settings.md"), true);
	});
	test("skips .github/ paths (PR templates, workflow docs)", () => {
		assert.equal(shouldSkipFile("/repo/.github/pull_request_template.md"), true);
		assert.equal(shouldSkipFile("/repo/.github/ISSUE_TEMPLATE/bug.md"), true);
	});
	test("skips templates/", () => {
		assert.equal(shouldSkipFile("/vault/templates/Work Note.md"), true);
	});
	test("skips thinking/", () => {
		assert.equal(shouldSkipFile("/vault/thinking/draft.md"), true);
	});
	test("skips Windows backslash path with .claude\\", () => {
		assert.equal(shouldSkipFile("C:\\vault\\.claude\\commands\\foo.md"), true);
	});
	test("does NOT skip a regular vault note", () => {
		assert.equal(shouldSkipFile("/vault/work/active/project.md"), false);
	});
	test("does NOT skip a normal .obsidian-ish name (only the literal segment matters)", () => {
		// ".obsidianish.md" is a .md file not inside .obsidian/
		assert.equal(shouldSkipFile("/vault/work/active/.obsidianish.md"), false);
	});
});

describe("validateContent — frontmatter + wikilinks", () => {
	test("missing frontmatter on long note", () => {
		const warnings = validateContent("No frontmatter here\n" + "x".repeat(300));
		assert.ok(warnings.includes("Missing YAML frontmatter"));
	});

	test("missing tags", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("Missing `tags`")));
	});

	test("missing description", () => {
		const c =
			"---\ndate: 2026-04-05\ntags:\n  - test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("Missing `description`")));
	});

	test("missing date", () => {
		const c =
			"---\ndescription: test\ntags:\n  - test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("Missing `date`")));
	});

	test("no wikilinks on long note", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\n# Note\n" +
			"x".repeat(300);
		const warnings = validateContent(c);
		assert.ok(warnings.some((w) => w.includes("No [[wikilinks]]")));
	});

	test("short note without wikilink is OK", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\nShort note.";
		assert.deepEqual(validateContent(c), []);
	});

	test("valid long note with wikilink produces no warnings", () => {
		const c =
			"---\ndate: 2026-04-05\ndescription: A valid test note\ntags:\n  - test\n---\n" +
			// Filler is its own paragraph: on the next line it would be a
			// hard-wrapped one (#247).
			"# Note\n\nSome content with [[a wikilink]] and more text.\n\n" +
			"x".repeat(300);
		assert.deepEqual(validateContent(c), []);
	});

	test("a hard-wrapped paragraph is warned about, naming its first line", () => {
		const c = "---\ndate: 2026-04-05\ndescription: d\ntags: [x]\n---\n# Note\n\nA paragraph that was\nwrapped at a narrow width.\n";
		const w = validateContent(c).filter((x) => x.includes("hard-wrapped"));
		assert.equal(w.length, 1);
		// Line 9 is the continuation: frontmatter is lines 1–5, the heading 6.
		assert.match(w[0]!, /^1 hard-wrapped paragraph line\(s\), first at line 9 /);
	});

	/**
	 * #319: the block was found with `content.split("---")`, so a value holding
	 * `---` ended it there and every later key was reported missing.
	 */
	test("a value containing --- does not end the frontmatter", () => {
		const c = "---\ndate: 2026-01-01\ndescription: before --- after\ntags: [x]\n---\nShort.";
		assert.deepEqual(validateContent(c), []);
	});

	test("the same with CRLF line endings", () => {
		const c = "---\r\ndate: 2026-01-01\r\ndescription: before --- after\r\ntags: [x]\r\n---\r\nShort.";
		assert.deepEqual(validateContent(c), []);
	});

	test("a CRLF block is really read, not skipped: a missing key is still reported", () => {
		// "No warnings" alone would also pass if the CRLF block were never found
		// and no field was checked; a key that IS missing proves it was read.
		const c = "---\r\ndate: 2026-01-01\r\ndescription: before --- after\r\n---\r\nShort.";
		assert.deepEqual(validateContent(c), ["Missing `tags` in frontmatter"]);
	});

	test("an unclosed frontmatter still gets no field checks", () => {
		const w = validateContent("---\ndate: 2026-01-01\nShort, and no closing line.");
		assert.ok(!w.some((x) => x.startsWith("Missing `")), w.join("\n"));
	});

	test("tolerates 'tags :' with space (alternate YAML style)", () => {
		const c =
			"---\ndate : 2026-04-05\ndescription : test\ntags :\n  - test\n---\n# Note\n" +
			"[[Link]] " +
			"x".repeat(300);
		// All three field checks should accept the alternate spacing.
		assert.deepEqual(validateContent(c), []);
	});
});

describe("isBlockedMemoryPath", () => {
	test("blocks non-MEMORY.md files in the auto-memory dir", () => {
		assert.equal(
			isBlockedMemoryPath("/u/x/.claude/projects/-p/memory/notes.md"),
			true,
		);
		assert.equal(
			isBlockedMemoryPath("C:\\u\\x\\.claude\\projects\\-p\\memory\\n.md"),
			true,
		);
	});
	test("allows MEMORY.md itself", () => {
		assert.equal(
			isBlockedMemoryPath("/u/x/.claude/projects/-p/memory/MEMORY.md"),
			false,
		);
	});
	test("requires both .claude and memory segments", () => {
		assert.equal(isBlockedMemoryPath("/vault/brain/Memories.md"), false);
		assert.equal(isBlockedMemoryPath("/u/x/.claude/projects/-p/transcripts/t.md"), false);
		assert.equal(isBlockedMemoryPath("/u/memory/notes.md"), false);
	});
	test("normalizes dot-dot segments before matching, both directions", () => {
		assert.equal(
			isBlockedMemoryPath("/u/.claude/projects/-p/transcripts/../memory/x.md"),
			true,
		);
		assert.equal(
			isBlockedMemoryPath("/u/.claude/projects/-p/memory/../transcripts/x.md"),
			false,
		);
	});
	test("collapses backslash-spelled dot-dot segments on any host", () => {
		// Separator unification must precede normalization, or this Windows
		// spelling would false-positive on POSIX hosts.
		assert.equal(
			isBlockedMemoryPath(
				"C:\\u\\.claude\\projects\\-p\\memory\\..\\transcripts\\x.md",
			),
			false,
		);
	});
});

describe("validateContent — ticket-ID phantom edges", () => {
	const BASE = "---\ntags: [x]\ndescription: \"d\"\ndate: 2026-01-01\n---\n[[Real Note]]\n";
	test("warns on bare and aliased ticket-ID wikilinks", () => {
		const warnings = validateContent(
			BASE + "See [[PROJ-1234]] and [[ABC-77|the ticket]].\n",
		);
		assert.equal(warnings.filter((w) => w.includes("ticket-ID")).length, 1);
		assert.match(warnings.find((w) => w.includes("ticket-ID")) ?? "", /2 ticket-ID/);
	});
	test("silent on normal wikilinks and plain-text ticket IDs", () => {
		const warnings = validateContent(
			BASE + "See PROJ-1234 (plain) and [[Architecture Notes]].\n",
		);
		assert.equal(warnings.filter((w) => w.includes("ticket-ID")).length, 0);
	});
});
