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
	type Destination,
} from "../lib/mcp-capture.ts";
import type { ExposurePolicy } from "../lib/mcp-exposure.ts";

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
			assert.throws(() => resolveDestination(dir, POLICY, {}, "atlas", "work/career", "note"), /not an exposed root/);
			assert.throws(() => resolveDestination(dir, POLICY, {}, "atlas", "people", "note"), /not an exposed root/);
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
		assert.match(md, /description: "Shipped the archive command behind a flag\."/);
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
		assert.ok(!/description: ".*".*"/.test(front.split("\n").find((l) => l.startsWith("description:")) ?? ""));
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
				/not an exposed root/,
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
