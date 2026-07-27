/**
 * Unit tests for session-start pure helpers.
 * The entry point itself (fs walk, git log, Obsidian CLI probe) is exercised
 * live when the hook fires; these tests lock the deterministic formatting
 * logic that doesn't need a real environment.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
	take,
	formatDateHeader,
	quoteForPosixShell,
	formatEnvExport,
	formatInjectionSize,
	injectionMode,
	applyInjectionBudget,
	shouldCollapseDir,
	formatCollapsedDir,
	parseInjectionBudget,
	parseListingCollapseThreshold,
	DEFAULT_LISTING_COLLAPSE_THRESHOLD,
	type BudgetSection,
	formatActiveWork,
	formatRecentChanges,
	isSkippedPath,
	MACHINERY_DIRS,
	extractFrontmatterField,
	formatBrainIndex,
	stripFrontmatter,
	hasBrainContent,
	parseQmdIndex,
	parseQmdMinVersion,
	isQmdNativeAbiMismatch,
	qmdPackageRootFromEntry,
	resolveIndexStorePath,
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

describe("quoteForPosixShell", () => {
	// One row per hazard, so a failure names the case that broke instead of
	// pointing at a single combined string.
	const cases: ReadonlyArray<readonly [string, string, string]> = [
		["plain path", "/home/me/vault", "'/home/me/vault'"],
		["variable expansion", "/a/$HOME/b", "'/a/$HOME/b'"],
		["command substitution", "/a/$(id)/b", "'/a/$(id)/b'"],
		["backtick substitution", "/a/`id`/b", "'/a/`id`/b'"],
		["double quote", '/a/"q"/b', "'/a/\"q\"/b'"],
		["command separator", "/a/;rm -rf x/b", "'/a/;rm -rf x/b'"],
		// Windows paths are the common real-world case for this template, and
		// backslash is literal inside single quotes.
		["windows path", "C:\\Users\\me\\vault", "'C:\\Users\\me\\vault'"],
		["trailing backslash", "/a/b\\", "'/a/b\\'"],
		["apostrophe", "/it's/vault", "'/it'\\''s/vault'"],
		["only an apostrophe", "'", "''\\'''"],
		["embedded newline", "a\nb", "'a\nb'"],
		["empty string", "", "''"],
	];
	for (const [label, input, expected] of cases) {
		test(label, () => {
			assert.equal(quoteForPosixShell(input), expected);
		});
	}
});

describe("formatEnvExport", () => {
	test("emits a complete, newline-terminated export line", () => {
		assert.equal(
			formatEnvExport("VAULT_PATH", "/home/me/vault"),
			"export VAULT_PATH='/home/me/vault'\n",
		);
	});

	test("quoting is applied without the caller asking for it", () => {
		assert.equal(
			formatEnvExport("VAULT_PATH", "/a/$(id)/b"),
			"export VAULT_PATH='/a/$(id)/b'\n",
		);
	});

	test("rejects names the shell could not accept", () => {
		for (const bad of ["", "1ABC", "A-B", "A B", "A;rm -rf /", "A=B", "$A"]) {
			assert.throws(
				() => formatEnvExport(bad, "x"),
				/unsafe env var name/,
				`should reject ${JSON.stringify(bad)}`,
			);
		}
	});

	test("accepts the portable name shapes", () => {
		for (const ok of ["A", "_A", "VAULT_PATH", "_x9"]) {
			assert.doesNotThrow(() => formatEnvExport(ok, "v"));
		}
	});
});

describe("session-start entry — env export cannot be hand-rolled", () => {
	// A source-level guard. The safe helper only helps if it is the thing the
	// entry actually calls; nothing in the type system stops someone writing
	// `export FOO="${bar}"` again, which is precisely the bug #145 fixed.
	const entry = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "session-start.ts"),
		"utf-8",
	);

	test("writes the env file through formatEnvExport", () => {
		assert.match(entry, /appendFileSync\(\s*envFile,\s*formatEnvExport\(/);
	});

	// Catches a hand-rolled line in any quoting style, not just backticks.
	const HANDROLLED = /["'`]export\s/;

	test("contains no hand-rolled `export ...=` literal", () => {
		assert.doesNotMatch(
			entry,
			HANDROLLED,
			"build the line with formatEnvExport instead of a string literal",
		);
	});

	test("does not reach past the helper to the raw quoter", () => {
		assert.doesNotMatch(
			entry,
			/quoteForPosixShell\(/,
			"the entry should call formatEnvExport, which quotes internally",
		);
	});

	// SKIP_PREFIXES is module-private and the entry runs on import, so the
	// wiring can only be pinned at the source level. Without this, #156
	// regresses silently: MACHINERY_DIRS keeps its entries and its own tests
	// keep passing while the listing walks a hardcoded list again.
	const SKIP_DEF = /const SKIP_PREFIXES[^=]*=\s*\[\s*\.\.\.MACHINERY_DIRS\s*,/;

	test("builds SKIP_PREFIXES from the shared machinery list (#156)", () => {
		assert.match(
			entry,
			SKIP_DEF,
			"the listing walk must spread MACHINERY_DIRS, not re-list dirs by hand",
		);
	});

	test("GUARD IS NOT VACUOUS — the pattern rejects a hand-listed set", () => {
		// The exact pre-#156 definition, which is what let .shardmind through.
		const regression =
			'const SKIP_PREFIXES: readonly string[] = [\n\t".git",\n\t".obsidian",\n\t"thinking",\n\t".claude",\n];';
		assert.doesNotMatch(regression, SKIP_DEF, "guard must reject the old literal");
	});

	// A guard that cannot fail is worse than no guard: it reads as coverage
	// while proving nothing. These assert the patterns above actually fire on
	// the regressions they exist to catch, including the exact pre-#145 line.
	test("GUARD IS NOT VACUOUS — the pattern catches every hand-rolled form", () => {
		const regressions = [
			'appendFileSync(envFile, `export VAULT_PATH="${cwd}"\\n`);', // the pre-#145 bug
			"appendFileSync(envFile, `export VAULT_PATH=${quoteForPosixShell(cwd)}\\n`);",
			'appendFileSync(envFile, "export FOO=" + bar);',
			"appendFileSync(envFile, 'export FOO=' + bar);",
		];
		for (const bad of regressions) {
			assert.match(bad, HANDROLLED, `guard must reject: ${bad}`);
		}
	});

	test("GUARD IS NOT VACUOUS — the raw-quoter pattern catches a direct call", () => {
		assert.match("const x = quoteForPosixShell(cwd);", /quoteForPosixShell\(/);
	});

	test("GUARD IS NOT VACUOUS — the required-call pattern rejects a missing call", () => {
		const required = /appendFileSync\(\s*envFile,\s*formatEnvExport\(/;
		assert.doesNotMatch("appendFileSync(envFile, someOtherThing());", required);
		assert.match("appendFileSync(envFile, formatEnvExport('A', b));", required);
	});
});

/**
 * The quoting contract is a claim about how a real POSIX shell parses the
 * output, so assert it against a real POSIX shell rather than against our own
 * idea of one. Runs on Linux/macOS CI and on Windows runners that ship Git
 * Bash; skips cleanly where no shell exists, so it can never be the reason
 * the suite fails on an exotic platform.
 */
const posixShell = (() => {
	for (const candidate of ["sh", "bash"]) {
		try {
			const r = spawnSync(candidate, ["-c", "printf ok"], { encoding: "utf-8" });
			if (r.status === 0 && r.stdout === "ok") return candidate;
		} catch {
			/* not available */
		}
	}
	return null;
})();

describe("quoteForPosixShell — verified against a real POSIX shell", () => {
	const skip = posixShell === null ? "no POSIX shell on this platform" : false;

	/** Round-trip every value in one shell invocation, NUL-delimited. */
	function roundTrip(values: readonly string[]): string[] {
		const dir = mkdtempSync(join(tmpdir(), "quote-roundtrip-"));
		try {
			const script = join(dir, "rt.sh");
			writeFileSync(
				script,
				values
					.map((v) => `V=${quoteForPosixShell(v)}\nprintf '%s\\0' "$V"`)
					.join("\n") + "\n",
			);
			const r = spawnSync(posixShell as string, [script], { encoding: "utf-8" });
			assert.equal(r.status, 0, `shell exited ${r.status}: ${r.stderr}`);
			const parts = (r.stdout ?? "").split("\0");
			parts.pop(); // trailing empty after the final delimiter
			return parts;
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	}

	test("adversarial paths round-trip byte-exact", { skip }, () => {
		const values = [
			"/home/me/vault",
			"/a/$HOME/b",
			"/a/$(id)/b",
			"/a/`id`/b",
			'/a/"q"/b',
			"/a/;rm -rf x/b",
			"/a/&& touch x/b",
			"/a/| tee x/b",
			"/it's/vault",
			"'",
			"''",
			"C:\\Users\\me\\vault",
			"/a/b\\",
			"/a/  spaces  /b",
			"/a/\t tab/b",
			"/ünïcodé/路径/vault",
			"/a/*/b",
			"/a/~root/b",
			"/a/!history/b",
			"/a/#comment/b",
			"/a/${IFS}/b",
			"",
		];
		assert.deepEqual(roundTrip(values), values);
	});

	test("no adversarial value can execute anything", { skip }, () => {
		// If substitution leaked, the marker file would exist afterwards.
		const dir = mkdtempSync(join(tmpdir(), "quote-exec-"));
		try {
			const marker = join(dir, "EXECUTED").replaceAll("\\", "/");
			roundTrip([`/a/$(touch ${marker})/b`, `/a/\`touch ${marker}\`/b`]);
			assert.throws(
				() => readFileSync(marker),
				"quoting leaked — a command substitution executed",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	});

	test("fuzz: generated hostile strings round-trip", { skip }, () => {
		// Deterministic LCG — a flaky fuzz test is worse than none.
		let seed = 0x2026_0724;
		const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		const alphabet = [..."abc/ '\"`$(){}[]|&;<>*?!#~\\\t=+:,.^%@-", "\n", "é", "路"];
		const values: string[] = [];
		for (let i = 0; i < 120; i++) {
			const len = 1 + Math.floor(rnd() * 24);
			let s = "";
			for (let j = 0; j < len; j++) {
				s += alphabet[Math.floor(rnd() * alphabet.length)] ?? "x";
			}
			values.push(s);
		}
		assert.deepEqual(roundTrip(values), values);
	});

	test("formatEnvExport output is a sourceable export", { skip }, () => {
		const dir = mkdtempSync(join(tmpdir(), "envexport-"));
		try {
			const envFile = join(dir, "env.sh");
			const value = "/a/$(id)/it's \"weird\"/b";
			writeFileSync(envFile, formatEnvExport("VAULT_PATH", value));
			const r = spawnSync(
				posixShell as string,
				["-c", `. "$1"; printf '%s' "$VAULT_PATH"`, "sh", envFile],
				{ encoding: "utf-8" },
			);
			assert.equal(r.status, 0, r.stderr);
			assert.equal(r.stdout, value, "sourcing the file must restore the exact path");
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
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
	test("preserves `.MD` and `.Md` files (case-insensitive matching)", () => {
		const out = formatActiveWork(
			["Note.md", "Note.MD", "Note.Md", "notes.txt"],
			10,
		);
		assert.equal(out, "Note\nNote\nNote");
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

describe("MACHINERY_DIRS", () => {
	// The listing walk is filesystem-level and does not read .gitignore, so
	// the engine's own tree has to be skipped by name.
	test("skips the ShardMind engine tree an installed vault carries (#156)", () => {
		// The cached template copy and every pre-update backup snapshot —
		// engine artifacts that outnumbered real notes 3:1 on a v7.0.1 install.
		assert.equal(
			isSkippedPath(".shardmind/templates/CLAUDE.md", MACHINERY_DIRS),
			true,
		);
		assert.equal(
			isSkippedPath(
				".shardmind/backups/update-2026-07-01T00:00:00Z/work/Index.md",
				MACHINERY_DIRS,
			),
			true,
		);
		assert.equal(isSkippedPath(".shardmind", MACHINERY_DIRS), true);
	});

	test("skips .github, which the segment boundary excludes from .git", () => {
		assert.equal(
			isSkippedPath(".github/pull_request_template.md", MACHINERY_DIRS),
			true,
		);
	});

	test("leaves user content alone", () => {
		for (const p of [
			"work/active/Note.md",
			"brain/Patterns.md",
			"templates/Work Note.md", // scaffold, but the listing does show it
		]) {
			assert.equal(isSkippedPath(p, MACHINERY_DIRS), false);
		}
	});

	test("holds only what is machinery for BOTH consumers", () => {
		// `thinking/` and `templates/` are each skipped by exactly one
		// consumer, so neither belongs in the shared list.
		assert.equal(MACHINERY_DIRS.includes("thinking"), false);
		assert.equal(MACHINERY_DIRS.includes("templates"), false);
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

describe("isQmdNativeAbiMismatch", () => {
	test("detects a NODE_MODULE_VERSION mismatch message", () => {
		assert.equal(
			isQmdNativeAbiMismatch(
				"Error: The module '.../better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 141. This version of Node.js requires\nNODE_MODULE_VERSION 147.",
			),
			true,
		);
	});
	test("detects the ERR_DLOPEN_FAILED error code alone", () => {
		assert.equal(isQmdNativeAbiMismatch("code: 'ERR_DLOPEN_FAILED'"), true);
	});
	test("returns false for unrelated stderr", () => {
		assert.equal(isQmdNativeAbiMismatch(""), false);
		assert.equal(isQmdNativeAbiMismatch("command not found: qmd"), false);
	});
});

describe("qmdPackageRootFromEntry", () => {
	test("strips dist/cli/qmd.js to return the package root", () => {
		const root = join("/opt/homebrew/lib/node_modules", "@tobilu", "qmd");
		const entry = join(root, "dist", "cli", "qmd.js");
		assert.equal(qmdPackageRootFromEntry(entry), root);
	});
	test("returns null for a null entry", () => {
		assert.equal(qmdPackageRootFromEntry(null), null);
	});
	test("returns null when the entry doesn't match the expected shape", () => {
		assert.equal(qmdPackageRootFromEntry("/some/other/path.js"), null);
	});
});

describe("parseQmdMinVersion", () => {
	test("extracts a declared min version", () => {
		assert.equal(
			parseQmdMinVersion(JSON.stringify({ qmd_min_version: "2.0.0" })),
			"2.0.0",
		);
	});
	test("null when absent, empty, non-string, or manifest malformed", () => {
		assert.equal(parseQmdMinVersion(JSON.stringify({})), null);
		assert.equal(
			parseQmdMinVersion(JSON.stringify({ qmd_min_version: "" })),
			null,
		);
		assert.equal(
			parseQmdMinVersion(JSON.stringify({ qmd_min_version: 2 })),
			null,
		);
		assert.equal(parseQmdMinVersion("not json"), null);
		assert.equal(parseQmdMinVersion(null), null);
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

describe("formatInjectionSize", () => {
	const cases: ReadonlyArray<readonly [number, string]> = [
		[0, "_context injected: 0.0kB_"],
		[999, "_context injected: 1.0kB_"], // toFixed rounds
		[300, "_context injected: 0.3kB_"],
		[58_400, "_context injected: 58.4kB_"],
		[1_048_576, "_context injected: 1048.6kB_"],
		[-5, "_context injected: 0.0kB_"],
		[Number.NaN, "_context injected: 0.0kB_"],
	];
	for (const [bytes, expected] of cases) {
		test(`${bytes} → ${expected}`, () => {
			assert.equal(formatInjectionSize(bytes), expected);
		});
	}

	test("an unset budget keeps the pre-budget line byte-identical", () => {
		assert.equal(formatInjectionSize(58_400, {}), "_context injected: 58.4kB_");
	});
	test("a budget with nothing collapsed reports the ceiling", () => {
		assert.equal(
			formatInjectionSize(30_000, { budgetBytes: 40_000 }),
			"_context injected: 30.0kB / 40.0kB budget_",
		);
	});
	test("collapsed sections are NAMED — a silent loss is worse than the bloat", () => {
		assert.equal(
			formatInjectionSize(39_800, {
				budgetBytes: 40_000,
				collapsed: ["Vault File Listing", "Brain Topics (read on demand)"],
			}),
			"_context injected: 39.8kB / 40.0kB budget — collapsed: Vault File Listing, Brain Topics (read on demand)_",
		);
	});
	test("a nonsense budget degrades to the plain meter, never throws", () => {
		for (const b of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(
				formatInjectionSize(1_000, { budgetBytes: b }),
				"_context injected: 1.0kB_",
			);
		}
	});
});

describe("applyInjectionBudget", () => {
	const mk = (
		header: string,
		body: string,
		priority: number,
		fallback?: string,
	): BudgetSection =>
		fallback === undefined
			? { header, body, priority }
			: { header, body, priority, fallback };

	test("under budget → untouched, nothing collapsed", () => {
		const s = [mk("### A", "short", 10, "(dropped)")];
		const r = applyInjectionBudget(s, 10_000);
		assert.equal(r.text, "### A\nshort");
		assert.deepEqual(r.collapsed, []);
	});

	test("renders header+body joined by a blank line (pre-budget shape)", () => {
		const r = applyInjectionBudget(
			[mk("", "## Session Context", 0), mk("### Date", "2026-07-24", 0)],
			10_000,
		);
		assert.equal(r.text, "## Session Context\n\n### Date\n2026-07-24");
	});

	test("surrenders the HIGHEST priority first", () => {
		const s = [
			mk("### Keep", "x".repeat(50), 10, "(k)"),
			mk("### Drop", "y".repeat(50), 90, "(d)"),
		];
		const r = applyInjectionBudget(s, 80);
		assert.deepEqual(r.collapsed, ["Drop"]);
		assert.match(r.text, /### Drop\n\(d\)/);
		assert.ok(
			!r.text.includes("y"),
			"the dropped body must be replaced WHOLE, not truncated — no residue",
		);
		assert.ok(r.text.includes("x".repeat(50)), "the lower-priority section survives");
	});

	test("keeps surrendering until it fits, in descending priority", () => {
		const s = [
			mk("### Third", "c".repeat(100), 10, "(c)"),
			mk("### First", "a".repeat(100), 50, "(a)"),
			mk("### Second", "b".repeat(100), 30, "(b)"),
		];
		// 335 B intact; 238 after First collapses; 141 after Second. A 150 B
		// ceiling therefore lands exactly two collapses deep and stops.
		const r = applyInjectionBudget(s, 150);
		assert.deepEqual(r.collapsed, ["First", "Second"]);
		assert.ok(r.text.includes("c".repeat(100)), "the lowest priority is still intact");
	});

	test("a section without a fallback is load-bearing and never degrades", () => {
		const s = [mk("### Identity", "z".repeat(500), 99)];
		const r = applyInjectionBudget(s, 10);
		assert.deepEqual(r.collapsed, []);
		assert.ok(r.text.includes("z".repeat(500)), "identity survives an impossible budget");
		assert.ok(r.bytes > 10, "over budget is reported honestly, not faked");
	});

	test("stops once it fits — does not over-collapse", () => {
		const s = [
			mk("### Big", "a".repeat(200), 50, "(a)"),
			mk("### Also", "b".repeat(60), 40, "(b)"),
		];
		const r = applyInjectionBudget(s, 100);
		assert.deepEqual(r.collapsed, ["Big"], "second section kept once the first freed enough");
	});

	test("a nonsense budget is a no-op, never throws", () => {
		const s = [mk("### A", "x".repeat(999), 10, "(short)")];
		for (const b of [0, -5, Number.NaN]) {
			const r = applyInjectionBudget(s, b);
			assert.deepEqual(r.collapsed, []);
			assert.ok(r.text.includes("x".repeat(999)));
		}
	});

	test("bytes are measured in UTF-8, not UTF-16 code units", () => {
		// Four 3-byte chars: 12 bytes, but only 4 .length units. A budget of 8
		// must therefore collapse — the bug this guards is measuring .length.
		const s = [mk("", "日本語版", 50, "x")];
		const r = applyInjectionBudget(s, 8);
		assert.deepEqual(r.collapsed, [""]);
	});
});

describe("shouldCollapseDir", () => {
	const flat = false;
	const tree = true;

	test("collapses a flat folder strictly above the threshold, not at it", () => {
		assert.equal(shouldCollapseDir(12, 12, [], "people", flat), false);
		assert.equal(shouldCollapseDir(13, 12, [], "people", flat), true);
	});

	test("NEVER collapses a folder with subdirectories, however large", () => {
		// The regression this locks: collapsing on recursive subtree count
		// folded `projects/`, `brain/` and `work/` into three lines and made
		// the vault's shape invisible. Structure is navigation; only flat
		// bulk is noise.
		assert.equal(shouldCollapseDir(9_999, 12, [], "projects", tree), false);
	});

	test("an always-collapse dir folds regardless of size OR structure", () => {
		// work/archive is year-foldered, so the subdir guard would spare it;
		// the explicit list is what makes semantic exceptions still work.
		assert.equal(
			shouldCollapseDir(1, 999, ["work/archive"], "work/archive", tree),
			true,
		);
	});

	test("matching is on the posix path, so nesting is respected", () => {
		assert.equal(shouldCollapseDir(1, 999, ["reference/cv"], "cv", flat), false);
	});

	test("a nonsense threshold collapses nothing by size", () => {
		for (const t of [0, -1, Number.NaN]) {
			assert.equal(shouldCollapseDir(9_999, t, [], "people", flat), false);
		}
	});
});

describe("formatCollapsedDir", () => {
	test("keeps the pre-threshold line shape verbatim", () => {
		assert.equal(
			formatCollapsedDir("work/archive", 42),
			"./work/archive/ — 42 notes (listing collapsed — Glob or QMD on demand)",
		);
	});
});

describe("manifest budget fields", () => {
	const cases: ReadonlyArray<readonly [string | null, number | null]> = [
		['{"eager_layer_budget_bytes":40000}', 40_000],
		['{"eager_layer_budget_bytes":0}', null], // non-positive → unset
		['{"eager_layer_budget_bytes":-1}', null],
		['{"eager_layer_budget_bytes":"40000"}', null], // string → unset
		['{"eager_layer_budget_bytes":1.5}', null], // non-integer → unset
		["{}", null],
		["not json", null],
		[null, null],
	];
	for (const [json, expected] of cases) {
		test(`parseInjectionBudget(${String(json)}) → ${String(expected)}`, () => {
			assert.equal(parseInjectionBudget(json), expected);
		});
	}

	test("parseListingCollapseThreshold reads its own field", () => {
		assert.equal(parseListingCollapseThreshold('{"listing_collapse_threshold":25}'), 25);
		assert.equal(parseListingCollapseThreshold('{"eager_layer_budget_bytes":25}'), null);
	});

	test("the shipped default threshold is a positive integer", () => {
		assert.ok(Number.isInteger(DEFAULT_LISTING_COLLAPSE_THRESHOLD));
		assert.ok(DEFAULT_LISTING_COLLAPSE_THRESHOLD > 0);
	});
});

describe("resolveIndexStorePath", () => {
	test("uses XDG_CACHE_HOME when set (matches qmd's own store rule)", () => {
		assert.equal(
			resolveIndexStorePath("my-vault", { XDG_CACHE_HOME: "/xdg/cache" }, "/home/u"),
			join("/xdg/cache", "qmd", "my-vault.sqlite"),
		);
	});
	test("falls back to ~/.cache when XDG_CACHE_HOME is unset", () => {
		assert.equal(
			resolveIndexStorePath("my-vault", {}, "/home/u"),
			join("/home/u", ".cache", "qmd", "my-vault.sqlite"),
		);
	});
});

describe("injectionMode", () => {
	const cases: ReadonlyArray<readonly [unknown, "full" | "pointer"]> = [
		["startup", "full"],
		["clear", "full"],
		["resume", "pointer"],
		["compact", "pointer"],
		[undefined, "full"], // missing source (Codex/Gemini)
		[null, "full"],
		[42, "full"], // non-string
	];
	for (const [source, expected] of cases) {
		test(`${String(source)} → ${expected}`, () => {
			assert.equal(injectionMode(source), expected);
		});
	}
});
