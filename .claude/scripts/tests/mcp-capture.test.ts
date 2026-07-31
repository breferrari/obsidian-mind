/**
 * Filing a work record.
 *
 * Three properties are load-bearing and each is asserted directly rather than
 * inferred from a happy path:
 *
 *   - a caller-supplied folder is VALIDATED against the exposed roots, so a
 *     destination string cannot become an arbitrary write;
 *   - the final name is claimed ATOMICALLY, because the obvious
 *     check-then-rename loses a whole capture to a race with no error; and
 *   - a link is emitted only when it resolves, because a note that
 *     manufactures broken links degrades the graph silently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	slugifyTitle,
	projectDirFor,
	resolveDestination,
	renderCapture,
	captureNote,
	clampDescription,
	yamlQuoted,
	type Destination,
} from "../lib/mcp-capture.ts";
import type { ExposurePolicy } from "../lib/mcp-exposure.ts";
import { resolvableNames } from "../lib/mcp-memory-bridge.ts";

const NOW = new Date("2026-07-26T10:00:00Z");
const POLICY: ExposurePolicy = { roots: ["brain", "projects"], neverExpose: new Set(), source: "manifest", memoryRoot: "memories" };

function withVault(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "cap-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const BASIC = {
	title: "Add the archive command",
	summary: "Shipped the archive command behind a flag.",
	changes: ["added cmd", "wired flag"],
	kind: "note",
};

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

describe("slugifying a title", () => {
	test("produces a filesystem-safe stem", () => {
		assert.equal(slugifyTitle("Add the archive command"), "add-the-archive-command");
	});

	test("strips separators rather than escaping them", () => {
		// This is the containment property: a title cannot contribute a path.
		for (const t of ["a/b", "a\\b", "../../etc/passwd", "a:b"]) {
			const s = slugifyTitle(t);
			assert.ok(!s.includes("/") && !s.includes("\\") && !s.includes(".."), `${t} → ${s}`);
		}
	});

	test("a title of only punctuation produces an empty stem, which is refused upstream", () => {
		assert.equal(slugifyTitle("!!!"), "");
		assert.equal(slugifyTitle(""), "");
	});

	test("is bounded, so a pathological title cannot make an unusable filename", () => {
		assert.ok(slugifyTitle("x".repeat(500)).length <= 60);
	});
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("finding a project folder", () => {
	test("exact, case-insensitive and prefix matches all resolve", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "projects", "pocket"), { recursive: true });
			assert.equal(projectDirFor(dir, "pocket")?.name, "pocket");
			assert.equal(projectDirFor(dir, "Pocket")?.name, "pocket");
			assert.equal(projectDirFor(dir, "poc")?.name, "pocket", "repo and folder names do not always agree");
		});
	});

	test("a vault with no projects/ folder is null, not a crash", () => {
		// A clean install of this template has no projects/ at all.
		withVault((dir) => assert.equal(projectDirFor(dir, "pocket"), null));
	});

	test("an anonymous caller has no project", () => {
		withVault((dir) => assert.equal(projectDirFor(dir, null), null));
	});
});

describe("resolving the destination", () => {
	test("a caller-chosen folder inside an exposed root is honoured", () => {
		withVault((dir) => {
			const d = resolveDestination(dir, POLICY, {}, "atlas", "brain/notes", "note");
			assert.equal(d.routed, "caller");
			assert.equal(d.rel, "brain/notes");
		});
	});

	test("a folder OUTSIDE the exposed roots is refused", () => {
		// The exposed roots bound writing as well as reading: a note lands in a
		// folder the vault declared, or the call is refused.
		withVault((dir) => {
			assert.throws(() => resolveDestination(dir, POLICY, {}, "atlas", "work/career", "note"), /not inside an exposed root/);
			assert.throws(() => resolveDestination(dir, POLICY, {}, "atlas", "people", "note"), /not inside an exposed root/);
		});
	});

	/**
	 * The fixture that was missing, and the reason the bug lived.
	 *
	 * Every existing case used `["brain", "projects"]` — single-segment — which
	 * cannot tell a first-segment match from a prefix match. The shipped manifest
	 * declares `work/active/`, `perf/brag/`, `org/people/`: on a default install
	 * the old check refused every root a user would actually file into, with the
	 * message *"'work' is not an exposed root (allowed: brain, work/active)"*,
	 * naming the root it had just refused. The `inbox/` fallback hid it.
	 */
	test("a multi-segment root is honoured, and its siblings are not", () => {
		withVault((dir) => {
			const multi: ExposurePolicy = {
				roots: ["brain", "work/active", "perf/brag"],
				neverExpose: new Set(),
				source: "manifest",
				memoryRoot: "memories",
			};
			for (const ok of ["work/active", "work/active/notes", "perf/brag", "brain"]) {
				assert.equal(resolveDestination(dir, multi, {}, "atlas", ok, "note").rel, ok, ok);
			}
			for (const no of ["work/secrets", "work", "people", "perf"]) {
				assert.throws(() => resolveDestination(dir, multi, {}, "atlas", no, "note"), /refused/, no);
			}
		});
	});

	test("a traversal that starts inside an exposed root is refused", () => {
		withVault((dir) => {
			assert.throws(
				() => resolveDestination(dir, POLICY, {}, "atlas", "brain/../../elsewhere", "note"),
				/traversal segment/,
			);
		});
	});

	test("a traversal that lands back INSIDE the vault is still refused", () => {
		// The one that got through. `brain/../work` passes the first-segment root
		// check and resolves to a path still inside the vault, so a containment
		// test against the vault accepted it — and the capture landed in work/,
		// which nobody named. Containment has to be against the DECLARED ROOT.
		withVault((dir) => {
			for (const escape of ["brain/../work", "brain/../../vault/work", "brain/./../org", "projects/../perf"]) {
				assert.throws(() => resolveDestination(dir, POLICY, {}, "atlas", escape, "note"), /refused/, escape);
			}
		});
	});

	test("caller identity routes into the matching project", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "projects", "atlas"), { recursive: true });
			const d = resolveDestination(dir, POLICY, {}, "atlas", undefined, "note");
			assert.equal(d.routed, "caller-identity");
			assert.equal(d.rel, "projects/atlas/notes");
			assert.equal(d.project, "atlas");
		});
	});

	test("a decision routes to decisions/ rather than notes/", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "projects", "atlas"), { recursive: true });
			assert.equal(resolveDestination(dir, POLICY, {}, "atlas", undefined, "decision").rel, "projects/atlas/decisions");
		});
	});

	test("an unknown caller falls back to the inbox", () => {
		withVault((dir) => {
			assert.equal(resolveDestination(dir, POLICY, {}, "unknown-repo", undefined, "note").routed, "fallback");
			assert.equal(resolveDestination(dir, POLICY, { mcp_inbox: "dump" }, null, undefined, "note").rel, "dump");
		});
	});

	test("an unsafe configured inbox falls back to the default", () => {
		withVault((dir) => {
			assert.equal(resolveDestination(dir, POLICY, { mcp_inbox: "../escape" }, null, undefined, "note").rel, "inbox");
		});
	});
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("rendering a capture", () => {
	const dest: Destination = { dir: "/v/projects/atlas/notes", rel: "projects/atlas/notes", project: "atlas", routed: "caller-identity" };

	test("carries frontmatter the vault's own validator would accept", () => {
		const md = renderCapture(BASIC, dest, "atlas", new Set(["atlas"]), NOW);
		assert.match(md, /^---\n/);
		assert.match(md, /date: 2026-07-26/);
		assert.match(md, /description: 'Shipped the archive command behind a flag\.'/);
		assert.match(md, /project: atlas/);
		assert.match(md, /source_repo: atlas/);
	});

	test("a resolvable informed_by becomes a wikilink; an unresolvable one does NOT", () => {
		// A capture that manufactures broken links degrades the graph silently and
		// trips the vault's own wikilink gate.
		const md = renderCapture(
			{ ...BASIC, informed_by: ["Gotchas", "Note That Does Not Exist"] },
			dest,
			"atlas",
			new Set(["atlas", "gotchas"]),
			NOW,
		);
		assert.match(md, /- \[\[Gotchas\]\]/);
		assert.match(md, /- Note That Does Not Exist _\(no note yet\)_/);
		assert.ok(!md.includes("[[Note That Does Not Exist]]"));
	});

	test("the project home link is emitted only when the project resolves by name", () => {
		assert.match(renderCapture(BASIC, dest, "atlas", new Set(["atlas"]), NOW), /- \[\[atlas\]\]/);
		assert.ok(!renderCapture(BASIC, dest, "atlas", new Set(), NOW).includes("[[atlas]]"));
	});

	test("empty sections are omitted rather than left as empty headings", () => {
		const md = renderCapture({ title: "t", summary: "s", kind: "note" }, dest, "atlas", new Set(), NOW);
		assert.ok(!md.includes("## What changed"));
		assert.ok(!md.includes("## Open"));
	});

	test("a quote in the summary cannot break the frontmatter", () => {
		const md = renderCapture({ ...BASIC, summary: 'He said "hello" today' }, dest, "atlas", new Set(), NOW);
		const front = md.slice(0, md.indexOf("\n---", 4));
		const line = front.split("\n").find((l) => l.startsWith("description:")) ?? "";
		// A double quote is now ordinary content, because the scalar is
		// single-quoted. What must not appear is an unescaped single quote.
		assert.match(line, /^description: '.*'$/);
		assert.equal(line, `description: 'He said "hello" today'`);
	});

	test("the routing decision is recorded in the note itself", () => {
		assert.match(renderCapture(BASIC, dest, "atlas", new Set(), NOW), /routing: caller-identity/);
	});
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe("writing a capture", () => {
	test("a dry run writes nothing and previews", () => {
		withVault((dir) => {
			const r = captureNote(dir, POLICY, {}, "atlas", { ...BASIC, dry_run: true }, new Set(), { now: NOW });
			assert.equal(r.written, false);
			assert.ok(r.preview);
			assert.equal(readdirSync(dir).length, 0, "nothing may touch disk");
		});
	});

	test("a note record takes the date prefix; a decision does not", () => {
		withVault((dir) => {
			const note = captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW });
			assert.match(note.path, /2026-07-26-add-the-archive-command\.md$/);
			const dec = captureNote(dir, POLICY, {}, null, { ...BASIC, kind: "decision" }, new Set(), { now: NOW });
			// A decision is a living document; a creation-date prefix would invert
			// its recency signal.
			assert.match(dec.path, /\/add-the-archive-command\.md$/);
		});
	});

	test("the file lands where it was routed, with its content", () => {
		withVault((dir) => {
			const r = captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW });
			const md = readFileSync(join(dir, r.path), "utf8");
			assert.match(md, /# Add the archive command/);
			assert.match(md, /- added cmd/);
		});
	});

	test("a colliding title takes the next suffix rather than overwriting", () => {
		// The obvious check-then-rename loses one capture entirely, with no error.
		withVault((dir) => {
			const a = captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW });
			const b = captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW });
			assert.notEqual(a.path, b.path);
			assert.match(b.path, /-2\.md$/);
			assert.ok(readFileSync(join(dir, a.path), "utf8").length > 0, "the first must survive");
		});
	});

	test("no temp file is left behind", () => {
		withVault((dir) => {
			const r = captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW });
			const leftovers = readdirSync(join(dir, "inbox")).filter((f) => f.endsWith(".tmp"));
			assert.deepEqual(leftovers, [], "a half-written note must never be visible to the indexer");
			assert.ok(r.written);
		});
	});

	test("an empty title is refused before anything is written", () => {
		withVault((dir) => {
			assert.throws(() => captureNote(dir, POLICY, {}, null, { ...BASIC, title: "!!!" }, new Set()), /empty filename/);
			assert.equal(readdirSync(dir).length, 0);
		});
	});

	test("a refused folder writes nothing at all", () => {
		withVault((dir) => {
			assert.throws(
				() => captureNote(dir, POLICY, {}, "atlas", { ...BASIC, folder: "work/secret" }, new Set()),
				/not inside an exposed root/,
			);
			assert.equal(readdirSync(dir).length, 0, "a refusal must not create the folder either");
		});
	});

	test("the reindex result is reported, so an unfindable note is not called a success", () => {
		withVault((dir) => {
			const ok = captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW, reindex: () => true });
			assert.equal(ok.indexed, true);
			const bad = captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW, reindex: () => false });
			assert.equal(bad.indexed, false);
		});
	});

	test("existing files in the destination are untouched", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "inbox"), { recursive: true });
			writeFileSync(join(dir, "inbox", "existing.md"), "keep me", "utf8");
			captureNote(dir, POLICY, {}, null, BASIC, new Set(), { now: NOW });
			assert.equal(readFileSync(join(dir, "inbox", "existing.md"), "utf8"), "keep me");
		});
	});
});

// ---------------------------------------------------------------------------
// A capture reachable by the name it calls itself (#180)
// ---------------------------------------------------------------------------

describe("a capture is reachable by its own title", () => {
	const dest: Destination = { dir: "/v/projects/atlas/notes", rel: "projects/atlas/notes", project: "atlas", routed: "caller-identity" };

	test("the title is carried as an alias, because the basename never is", () => {
		const title = "I3 lands: a soak over the whole pipeline";
		const md = renderCapture({ title, summary: "s", kind: "note" }, dest, "atlas", new Set(), NOW);
		assert.match(md, /^aliases:\n {2}- 'I3 lands: a soak over the whole pipeline'$/m);
	});

	test("a title with a quote cannot break the frontmatter", () => {
		const md = renderCapture({ title: 'The "obvious" fix', summary: "s", kind: "note" }, dest, "atlas", new Set(), NOW);
		// A double quote is ordinary content inside a single-quoted scalar.
		assert.match(md, /^ {2}- 'The "obvious" fix'$/m);
	});

	test("an empty title emits no alias block rather than an empty one", () => {
		const md = renderCapture({ title: "", summary: "s", kind: "note" }, dest, "atlas", new Set(), NOW);
		assert.doesNotMatch(md, /^aliases:/m);
	});

	/**
	 * The two characters that end a scalar early, and neither is a quote.
	 *
	 * A double-quoted YAML scalar processes escapes, so a Windows path is a parse
	 * error (`\t` is TAB, `\x` wants two hex digits) — and this repo's own
	 * fixtures carry `C:\` paths on purpose. A newline ends the scalar at a
	 * column-zero continuation, which is under-indented for the block it sits in.
	 * Either one takes the WHOLE frontmatter block down, not just its own field,
	 * which is why these are asserted on the document rather than on the value.
	 */
	const HOSTILE: ReadonlyArray<readonly [string, string]> = [
		["a newline", "First line\nSecond line"],
		["a Windows path", "A path C:\\temp\\x"],
		["a single quote", "It's the resolver's problem"],
		["a YAML comment marker", "I3: #5 lands - done"],
	];

	for (const [label, title] of HOSTILE) {
		test(`${label} in the title cannot break the frontmatter`, () => {
			const md = renderCapture({ title, summary: title, kind: "note" }, dest, "atlas", new Set(), NOW);

			assert.equal((md.match(/^---$/gm) ?? []).length, 2, "exactly one frontmatter block");

			const front = md.slice(4, md.indexOf("\n---\n", 4));
			// Scoped to the aliases block: `tags:` also emits `  - ` items, and a
			// filter over the whole frontmatter counts those as extra alias lines.
			const aliasBlock = front.match(/^aliases:\n((?: {2}- .*\n?)+)/m);
			const aliasLines = (aliasBlock?.[1] ?? "").split("\n").filter(Boolean);
			assert.equal(aliasLines.length, 1, `the alias must occupy one line, got ${JSON.stringify(aliasLines)}`);
			assert.match(aliasLines[0]!, /^ {2}- '.*'$/, "single-quoted scalar");

			// No line of the frontmatter may start a new key after the block began
			// unexpectedly — a leaked newline shows up exactly here.
			for (const line of front.split("\n")) {
				assert.ok(line === "" || /^(\S+:|\s+-\s|\s+\S+:)/.test(line), `stray frontmatter line: ${JSON.stringify(line)}`);
			}
		});
	}

	test("a backslash survives literally rather than as an escape", () => {
		const md = renderCapture({ title: "A path C:\\temp\\x", summary: "s", kind: "note" }, dest, "atlas", new Set(), NOW);
		assert.match(md, /^ {2}- 'A path C:\\temp\\x'$/m);
	});

	test("a single quote is doubled, which is the only escape the form has", () => {
		assert.equal(yamlQuoted("It's here"), "'It''s here'");
		assert.equal(yamlQuoted('He said "hi"'), `'He said "hi"'`);
		assert.equal(yamlQuoted("a\n\nb"), "'a b'");
	});

	test("round trip: a hostile title still resolves through resolvableNames", () => {
		for (const [, title] of HOSTILE) {
			withVault((dir) => {
				captureNote(dir, POLICY, {}, null, { title, summary: "s", kind: "note" }, new Set(), { now: NOW });
				const files = readdirSync(join(dir, "inbox"));
				const label = files[0]!.replace(/\.md$/, "");
				const resolvable = resolvableNames([{ label, full: join(dir, "inbox", files[0]!), scope: "inbox" }]);
				// Whitespace is flattened by the scalar, so that is the name to expect.
				const flat = title.replace(/\s+/g, " ").trim().toLowerCase();
				assert.ok(resolvable.has(flat), `must resolve by ${JSON.stringify(flat)}`);
			});
		}
	});

	/**
	 * The regression that motivated #180, asserted end to end rather than on the
	 * alias line alone. Writing the alias is the mechanism; being resolvable is
	 * the property, and only the round trip proves the two agree.
	 *
	 * Before the fix this failed on every capture, not only long-titled ones:
	 * the basename carries a date prefix, is lowercased and has its punctuation
	 * stripped, so it is never the title even when nothing was truncated.
	 */
	test("round trip: a written capture resolves by title through resolvableNames", () => {
		withVault((dir) => {
			const title = "The harden audit of I2b found a live I9 breach the suite could not see";
			captureNote(dir, POLICY, {}, null, { title, summary: "s", kind: "note" }, new Set(), { now: NOW });

			const files = readdirSync(join(dir, "inbox"));
			assert.equal(files.length, 1, "exactly one capture written");

			const label = files[0]!.replace(/\.md$/, "");
			// The precondition is that the basename is not the title — NOT that it
			// is shorter. It carries an 11-character date prefix, so a slug cut at
			// 60 can be longer than the title it came from and still not be it.
			assert.notEqual(label.toLowerCase(), title.toLowerCase(), "precondition: the basename is a slug, not the title");

			const resolvable = resolvableNames([{ label, full: join(dir, "inbox", files[0]!), scope: "inbox" }]);
			assert.ok(resolvable.has(title.toLowerCase()), "the note must resolve by the name it calls itself");
		});
	});
});

// ---------------------------------------------------------------------------
// Descriptions stop at a word (#180)
// ---------------------------------------------------------------------------

describe("clamping a description", () => {
	test("a short description is returned whole and unmarked", () => {
		assert.equal(clampDescription("Short and complete.", 150), "Short and complete.");
	});

	/**
	 * The fixture is irregular on purpose, and the first version of this test was
	 * wrong in a way worth keeping the note about: it used `"alpha ".repeat(60)`,
	 * where the token length divides the budget so the *hard cut* lands on a word
	 * boundary by arithmetic accident. Disabling the word-break entirely still
	 * passed. A fixture has to distinguish the implementation from its mutation,
	 * and one built from a single repeated token cannot.
	 *
	 * So: varied word lengths, and the assertion is that every character returned
	 * came from a whole word of the input.
	 */
	const PROSE = "the settle margin stays at two seconds because granularity is not uniform within one volume";

	for (const max of [30, 41, 57, 60, 73]) {
		test(`a long one breaks on whitespace and says it was cut (budget ${max})`, () => {
			const out = clampDescription(PROSE, max);
			assert.ok(out.endsWith("…"), "truncation must be visible");
			assert.ok(out.length <= max, `stayed within budget, got ${out.length}`);

			const kept = out.slice(0, -1);
			const words = PROSE.split(" ");
			// Every token kept must be a complete word of the source, and the next
			// source word must not fit — otherwise it broke early rather than late.
			const keptWords = kept.split(" ");
			assert.deepEqual(keptWords, words.slice(0, keptWords.length), `broke mid-word: ${JSON.stringify(out)}`);
		});
	}

	test("a budget containing no whitespace still marks the cut", () => {
		const out = clampDescription("x".repeat(400), 50);
		assert.equal(out.length, 50);
		assert.ok(out.endsWith("…"));
	});

	test("trailing punctuation is not left dangling before the ellipsis", () => {
		assert.doesNotMatch(clampDescription("one two three, four five six seven", 22), /[,;:–—-]…$/);
	});

	test("whitespace is flattened, and quoting is left to the scalar", () => {
		assert.equal(clampDescription('a\n\nb  "c"', 150), 'a b "c"');
	});
});
