/**
 * Serving a promoted lesson through the capture that still declares its reach.
 *
 * Three properties carry the design and each is asserted directly:
 *
 *   - serving is OPT-IN: a marker without an anchor is named and never served,
 *     so every capture promoted before this existed keeps its old behaviour;
 *   - the exposure policy still bounds the read, because this is the first time
 *     `recall` reaches outside the memory root; and
 *   - a stale anchor DEGRADES to the capture rather than widening to the whole
 *     note — returning a `Gotchas` note because one bullet was promoted is the
 *     failure this mechanism exists to avoid.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
	parsePromotedMarker,
	isExposed,
	blockAt,
	sectionAt,
	resolvePromoted,
} from "../lib/memory-promoted.ts";
import type { ExposurePolicy } from "../lib/mcp-exposure.ts";

const POLICY: ExposurePolicy = {
	roots: ["brain", "projects"],
	neverExpose: new Set(),
	source: "manifest",
	memoryRoot: "memories",
};

function withVault(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "promo-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function write(dir: string, rel: string, body: string): void {
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body, "utf8");
}

const NOTE = `---
description: "a topic note"
---

# Gotchas - Engineering

- **First entry.** Something unrelated. ^om-first
- **The promoted one.** The corrected text, swept. ^om-a1b2c3
- **Third entry.** Also unrelated.

## How this is known

Measured on the reference machine.

### Deeper

Detail.

## After

Not part of the section above.
`;

describe("parsing a promoted marker", () => {
	test("a block anchor", () => {
		assert.deepEqual(parsePromotedMarker("brain/Gotchas - Engineering#^om-a1b2c3"), {
			note: "brain/Gotchas - Engineering.md",
			anchor: "om-a1b2c3",
			kind: "block",
		});
	});

	test("a heading anchor", () => {
		assert.deepEqual(parsePromotedMarker("brain/Gotchas#How this is known"), {
			note: "brain/Gotchas.md",
			anchor: "How this is known",
			kind: "heading",
		});
	});

	test("a bare note is a note reference, which is never served", () => {
		assert.deepEqual(parsePromotedMarker("brain/Gotchas"), { note: "brain/Gotchas.md", anchor: null, kind: "note" });
	});

	test("an explicit .md does not become .md.md", () => {
		assert.equal(parsePromotedMarker("brain/Gotchas.md#^x")?.note, "brain/Gotchas.md");
		assert.equal(parsePromotedMarker("brain/Gotchas.MD")?.note, "brain/Gotchas.MD");
	});

	test("empty and junk markers are null rather than a path", () => {
		for (const junk of ["", "   ", null, undefined, 42]) {
			assert.equal(parsePromotedMarker(junk), null, String(junk));
		}
		assert.equal(parsePromotedMarker("#^orphan"), null, "an anchor with no note is not a reference");
	});

	test("a bare ^ is treated as no anchor rather than as an empty block id", () => {
		assert.equal(parsePromotedMarker("brain/Gotchas#^")?.kind, "note");
	});
});

describe("the exposure policy still bounds the read", () => {
	test("an exposed root is allowed", () => {
		withVault((d) => assert.equal(isExposed(d, POLICY, "brain/Gotchas.md"), true));
	});

	test("an unexposed root is refused", () => {
		withVault((d) => {
			for (const p of ["people/Someone.md", "work/career/Thing.md", "perf/Brag Doc.md"]) {
				assert.equal(isExposed(d, POLICY, p), false, p);
			}
		});
	});

	test("the memory root is refused even though it is where recall reads", () => {
		withVault((d) => assert.equal(isExposed(d, POLICY, "memories/2026/07/x.md"), false));
	});

	test("a traversal out of an exposed root is refused", () => {
		withVault((d) => {
			for (const p of ["brain/../people/Someone.md", "brain/../../etc/passwd", "brain/./../work/x.md"]) {
				assert.equal(isExposed(d, POLICY, p), false, p);
			}
		});
	});
});

describe("locating a block", () => {
	test("an id at the end of a line returns that line without the id", () => {
		const got = blockAt(NOTE, "om-a1b2c3");
		assert.equal(got, "- **The promoted one.** The corrected text, swept.");
		assert.ok(!got?.includes("^om-a1b2c3"), "the id is addressing, not content");
	});

	test("the right block, not merely a block", () => {
		assert.match(blockAt(NOTE, "om-first") ?? "", /First entry/);
	});

	test("an id alone on its own line takes the paragraph above it", () => {
		const md = "# T\n\nA paragraph that was promoted.\n^om-para\n\nSomething else.\n";
		assert.equal(blockAt(md, "om-para"), "A paragraph that was promoted.");
	});

	test("a missing id is null, never a fallback to the whole note", () => {
		assert.equal(blockAt(NOTE, "om-does-not-exist"), null);
	});

	test("an id inside frontmatter cannot be matched", () => {
		const md = "---\naliases:\n  - 'x ^om-fm'\n---\n\n# T\n\nBody.\n";
		assert.equal(blockAt(md, "om-fm"), null);
	});

	test("a regex metacharacter in an id is matched literally", () => {
		const md = "# T\n\n- an entry ^om-a.c\n- another ^om-abc\n";
		assert.match(blockAt(md, "om-a.c") ?? "", /an entry/);
	});
});

describe("locating a section", () => {
	test("returns the section and stops at the next heading of the same level", () => {
		const got = sectionAt(NOTE, "How this is known") ?? "";
		assert.match(got, /Measured on the reference machine/);
		assert.match(got, /Deeper/, "a deeper heading is part of the section");
		assert.doesNotMatch(got, /Not part of the section above/);
	});

	test("matching is on text rather than level, so deepening a heading does not strand it", () => {
		assert.ok(sectionAt(NOTE.replace("## How this is known", "### How this is known"), "How this is known"));
	});

	test("a missing heading is null", () => {
		assert.equal(sectionAt(NOTE, "No Such Heading"), null);
	});
});

describe("resolving a marker end to end", () => {
	test("no marker at all is null, which is not the same as unservable", () => {
		withVault((d) => assert.equal(resolvePromoted(d, POLICY, undefined), null));
	});

	test("an anchored marker in an exposed root serves the promoted text", () => {
		withVault((d) => {
			write(d, "brain/Gotchas - Engineering.md", NOTE);
			const r = resolvePromoted(d, POLICY, "brain/Gotchas - Engineering#^om-a1b2c3");
			assert.equal(r?.status, "served");
			assert.equal(r?.status === "served" && r.text, "- **The promoted one.** The corrected text, swept.");
		});
	});

	/** The opt-in property, and the reason every already-promoted capture is safe. */
	test("a bare marker is named but never served, even when the note exists", () => {
		withVault((d) => {
			write(d, "brain/Gotchas - Engineering.md", NOTE);
			assert.equal(resolvePromoted(d, POLICY, "brain/Gotchas - Engineering")?.status, "no-anchor");
		});
	});

	test("an anchored marker outside the exposed roots is refused, not served", () => {
		withVault((d) => {
			write(d, "people/Someone.md", "# S\n\n- private ^om-x\n");
			const r = resolvePromoted(d, POLICY, "people/Someone#^om-x");
			assert.equal(r?.status, "not-exposed");
			assert.ok(!(r && "text" in r), "no content may cross the policy");
		});
	});

	test("a traversal dressed as an exposed root is refused", () => {
		withVault((d) => {
			write(d, "people/Someone.md", "# S\n\n- private ^om-x\n");
			assert.equal(resolvePromoted(d, POLICY, "brain/../people/Someone#^om-x")?.status, "not-exposed");
		});
	});

	test("a stale anchor degrades to the capture rather than widening to the note", () => {
		withVault((d) => {
			write(d, "brain/Gotchas - Engineering.md", NOTE);
			const r = resolvePromoted(d, POLICY, "brain/Gotchas - Engineering#^om-gone");
			assert.equal(r?.status, "stale-anchor");
			assert.ok(!(r && "text" in r), "a stale pointer must never serve the whole note");
		});
	});

	test("a missing note is unreadable rather than a crash", () => {
		withVault((d) => assert.equal(resolvePromoted(d, POLICY, "brain/Nope#^om-x")?.status, "unreadable"));
	});
});

// ---------------------------------------------------------------------------
// Adversarial: things that should not serve, crash, or hang
// ---------------------------------------------------------------------------

describe("trying to break the resolver", () => {
	test("an absolute path and a UNC path are refused", () => {
		withVault((d) => {
			const hostile = [
				"/etc/passwd#^x",
				String.raw`C:\Windows\win.ini#^x`,
				String.raw`\\host\share\x#^x`,
				"//host/share/x#^x",
			];
			for (const p of hostile) {
				const r = resolvePromoted(d, POLICY, p);
				assert.notEqual(r?.status, "served", p);
			}
		});
	});

	test("a root that merely PREFIXES an exposed one is refused", () => {
		// "brainstorm" starts with "brain" — a startsWith check on the raw string
		// would let it through, and it is a different folder.
		withVault((d) => {
			write(d, "brainstorm/Secret.md", "# S\n\n- leak ^om-x\n");
			assert.equal(resolvePromoted(d, POLICY, "brainstorm/Secret#^om-x")?.status, "not-exposed");
		});
	});

	test("case variation cannot smuggle a root past the check", () => {
		withVault((d) => {
			write(d, "brain/Gotchas - Engineering.md", NOTE);
			// Case-insensitive is deliberate: on Windows and macOS the filesystem
			// is too, so a case-sensitive check would refuse a legitimate marker
			// while the file resolved anyway.
			assert.equal(resolvePromoted(d, POLICY, "BRAIN/Gotchas - Engineering#^om-a1b2c3")?.status, "served");
			assert.equal(resolvePromoted(d, POLICY, "PEOPLE/Someone#^om-x")?.status, "not-exposed");
		});
	});

	test("a hash inside a filename does not become an anchor boundary error", () => {
		withVault((d) => {
			write(d, "brain/C# notes.md", "# T\n\n- entry ^om-cs\n");
			// The FIRST hash splits, so this note is addressed as `brain/C` — which
			// does not exist. Refusing is correct; silently reading a neighbouring
			// file would not be. Documented so the behaviour is chosen, not luck.
			assert.equal(resolvePromoted(d, POLICY, "brain/C# notes#^om-cs")?.status, "unreadable");
		});
	});

	test("a directory named like a note is unreadable rather than a crash", () => {
		withVault((d) => {
			mkdirSync(join(d, "brain", "Folder.md"), { recursive: true });
			assert.equal(resolvePromoted(d, POLICY, "brain/Folder#^om-x")?.status, "unreadable");
		});
	});

	test("a note that is entirely frontmatter yields no block", () => {
		withVault((d) => {
			write(d, "brain/Empty.md", "---\ndescription: 'x'\n---\n");
			assert.equal(resolvePromoted(d, POLICY, "brain/Empty#^om-x")?.status, "stale-anchor");
		});
	});

	test("a duplicated block id returns the first, deterministically", () => {
		withVault((d) => {
			write(d, "brain/Dup.md", "# T\n\n- first ^om-dup\n- second ^om-dup\n");
			const r = resolvePromoted(d, POLICY, "brain/Dup#^om-dup");
			assert.equal(r?.status === "served" && r.text, "- first");
		});
	});

	test("a pathological id cannot hang the matcher", () => {
		// Regex metacharacters are escaped, so this is a literal search rather
		// than a catastrophic backtrack.
		const evil = "(a+)+".repeat(50);
		const md = `# T\n\n- entry ^om-x\n`;
		const started = Date.now();
		assert.equal(blockAt(md, evil), null);
		assert.ok(Date.now() - started < 1000, "must not backtrack");
	});

	test("CRLF line endings resolve the same as LF", () => {
		withVault((d) => {
			write(d, "brain/Crlf.md", NOTE.replace(/\n/g, "\r\n"));
			const r = resolvePromoted(d, POLICY, "brain/Crlf#^om-a1b2c3");
			assert.equal(r?.status, "served");
			assert.match(r?.status === "served" ? r.text : "", /The promoted one/);
		});
	});

	test("an id that is a prefix of another does not match the longer one", () => {
		withVault((d) => {
			write(d, "brain/Pfx.md", "# T\n\n- long ^om-abcdef\n");
			assert.equal(resolvePromoted(d, POLICY, "brain/Pfx#^om-abc")?.status, "stale-anchor");
		});
	});
});

// ---------------------------------------------------------------------------
// Scale: the cost must follow distinct NOTES, not promoted memories
// ---------------------------------------------------------------------------

describe("resolving at scale", () => {
	test("many entries pointing at one note read it once", () => {
		withVault((d) => {
			write(d, "brain/Big.md", NOTE);
			const cache = new Map<string, string | null>();
			for (let i = 0; i < 500; i++) {
				assert.equal(resolvePromoted(d, POLICY, "brain/Big#^om-a1b2c3", cache)?.status, "served");
			}
			assert.equal(cache.size, 1, "the cache key is the note, so one entry for 500 resolutions");
		});
	});

	test("the cache is consulted rather than the disk", () => {
		// Deterministic proof, no timing: the file does not exist, so a resolution
		// that succeeds can only have come from the cache.
		withVault((d) => {
			const cache = new Map<string, string | null>([["brain/Ghost.md", NOTE]]);
			assert.equal(resolvePromoted(d, POLICY, "brain/Ghost#^om-a1b2c3", cache)?.status, "served");
			assert.equal(resolvePromoted(d, POLICY, "brain/Ghost#^om-a1b2c3")?.status, "unreadable", "without the cache");
		});
	});

	test("an unreadable note is cached too, so it is stat-ed once", () => {
		withVault((d) => {
			const cache = new Map<string, string | null>();
			for (let i = 0; i < 100; i++) resolvePromoted(d, POLICY, "brain/Missing#^om-x", cache);
			assert.equal(cache.size, 1);
			assert.equal(cache.get("brain/Missing.md"), null);
		});
	});

	test("a large note with a deep anchor stays well inside a frame", () => {
		withVault((d) => {
			const filler = Array.from({ length: 20_000 }, (_, i) => `- filler entry ${i} with some prose after it`).join("\n");
			write(d, "brain/Huge.md", `---\ndescription: 'x'\n---\n\n# Huge\n\n${filler}\n- **The one.** Corrected. ^om-deep\n`);
			const cache = new Map<string, string | null>();
			const started = Date.now();
			for (let i = 0; i < 50; i++) {
				assert.equal(resolvePromoted(d, POLICY, "brain/Huge#^om-deep", cache)?.status, "served");
			}
			const ms = Date.now() - started;
			assert.ok(ms < 5000, `50 resolutions over a ~1MB note took ${ms}ms`);
		});
	});
});
