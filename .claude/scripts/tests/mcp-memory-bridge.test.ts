/**
 * The seam between the memory core and a real vault.
 *
 * Every function here has already failed once in a way that produced an EMPTY
 * result rather than an error, which is the one outcome this system cannot tell
 * apart from a correct one. So each block includes the specific shape that
 * broke: a project note outside the exposed roots, a README whose name is not
 * its project's name, an index that answers with memories scoped elsewhere.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
	resolvableNames,
	loadMemoryDigests,
	findNoteNamed,
	callerPlatforms,
	semanticMemoryOrder,
} from "../lib/mcp-memory-bridge.ts";
import type { VisibleFile } from "../lib/mcp-exposure.ts";
import type { QmdClient } from "../lib/mcp-qmd-client.ts";

function put(dir: string, rel: string, body: string): string {
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body, "utf8");
	return full;
}

function withVault(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "bridge-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const memory = (title: string, extra = ""): string =>
	`---\ndate: 2026-07-26\nsource: mcp-capture\nscope: general\n${extra}\n---\n\n# ${title}\n\nthe body.\n`;

/** A fake index that returns whatever files it was told to. */
function fakeQmd(files: string[] | null, fail = false): QmdClient {
	return {
		ready: Promise.resolve(),
		dispose: () => {},
		alive: true,
		call: async () => {
			if (fail) throw new Error("index down");
			return files === null ? {} : { structuredContent: { results: files.map((f) => ({ file: f })) } };
		},
	};
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

describe("names a wikilink may resolve to", () => {
	test("a file basename resolves", () => {
		withVault((dir) => {
			const full = put(dir, "brain/Gotchas.md", "---\ndate: 2026-07-26\n---\n\n# G\n");
			const files: VisibleFile[] = [{ full, label: "Gotchas", scope: "brain" }];
			assert.ok(resolvableNames(files).has("gotchas"));
		});
	});

	test("a block-form alias resolves — this is the README case", () => {
		// projects/pocket/README.md is reachable as [[pocket]] ONLY via its alias.
		// Without this, every capture linking to a project manufactured a broken
		// link, every time.
		withVault((dir) => {
			const full = put(dir, "projects/pocket/README.md", "---\naliases:\n  - pocket\n  - Pocket App\n---\n\n# P\n");
			const names = resolvableNames([{ full, label: "README", scope: "projects" }]);
			assert.ok(names.has("pocket"));
			assert.ok(names.has("pocket app"));
			assert.ok(names.has("readme"), "the basename still resolves too");
		});
	});

	test("an inline-form alias resolves", () => {
		withVault((dir) => {
			const full = put(dir, "a/README.md", '---\naliases: ["atlas", \'Atlas API\']\n---\n\n# A\n');
			const names = resolvableNames([{ full, label: "README", scope: "a" }]);
			assert.ok(names.has("atlas"));
			assert.ok(names.has("atlas api"));
		});
	});

	test("an unreadable file still contributes its basename", () => {
		const names = resolvableNames([{ full: join(tmpdir(), "gone-xyz.md"), label: "Ghost", scope: "x" }]);
		assert.ok(names.has("ghost"));
	});

	test("a note with no aliases contributes exactly one name", () => {
		withVault((dir) => {
			const full = put(dir, "a.md", "---\ndate: 2026-07-26\n---\n\n# A\n");
			assert.equal(resolvableNames([{ full, label: "A", scope: "x" }]).size, 1);
		});
	});
});

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

describe("loading memory digests", () => {
	test("reads title, body and facets", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md", memory("tokens expire fast", "projects: [atlas]\nconfidence: verified"));
			const [d] = loadMemoryDigests(dir, "memories");
			assert.equal(d!.title, "tokens expire fast");
			assert.equal(d!.body, "the body.");
			assert.deepEqual(d!.projects, ["atlas"]);
			assert.equal(d!.confidence, "verified");
			assert.ok(d!.full.endsWith("a.md"), "the full path travels, so the index can be joined on it");
		});
	});

	test("a human note in the memory folder is ignored, not governed", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/mine.md", "---\ndate: 2026-07-26\ntags: [note]\n---\n\n# mine\n\nhand written\n");
			put(dir, "memories/2026/07/a.md", memory("agent written"));
			const digests = loadMemoryDigests(dir, "memories");
			assert.equal(digests.length, 1);
			assert.equal(digests[0]!.title, "agent written");
		});
	});

	test("an empty store is an empty list", () => {
		withVault((dir) => assert.deepEqual(loadMemoryDigests(dir, "memories"), []));
	});
});

// ---------------------------------------------------------------------------
// Finding the caller's own note
// ---------------------------------------------------------------------------

describe("finding a note by name", () => {
	test("finds it wherever the vault happens to keep it", () => {
		withVault((dir) => {
			put(dir, "work/active/atlas.md", "---\n---\n\n# A\n");
			assert.ok(findNoteNamed(dir, "atlas", "memories"));
		});
	});

	test("does not walk the memory tree", () => {
		// A memory is never a project note, and walking the store makes this cost
		// grow with the number of memories for no benefit.
		withVault((dir) => {
			put(dir, "memories/2026/07/atlas.md", memory("atlas"));
			assert.equal(findNoteNamed(dir, "atlas", "memories"), null);
		});
	});

	test("skips dot-directories and node_modules", () => {
		withVault((dir) => {
			put(dir, ".git/atlas.md", "x");
			put(dir, "node_modules/pkg/atlas.md", "x");
			assert.equal(findNoteNamed(dir, "atlas", "memories"), null);
		});
	});

	test("matching is case-insensitive", () => {
		withVault((dir) => {
			put(dir, "work/Atlas.md", "---\n---\n\n# A\n");
			assert.ok(findNoteNamed(dir, "atlas", "memories"));
		});
	});
});

// ---------------------------------------------------------------------------
// Platforms — the boundary that took two tries
// ---------------------------------------------------------------------------

describe("the caller's platforms", () => {
	test("read from the project's own note", () => {
		withVault((dir) => {
			put(dir, "work/atlas.md", "---\nplatforms: [ios, watchos]\n---\n\n# A\n");
			assert.deepEqual(callerPlatforms(dir, "atlas", "memories"), ["ios", "watchos"]);
		});
	});

	test("frontmatter LONGER than a head read is still parsed in full", () => {
		// The third near-miss, caught in review. Reading only the head here looks
		// like the same optimisation the other frontmatter probes in this module
		// took, but those replaced an equally-sized character slice while this
		// replaced a whole-file read. `parseFrontmatter` needs the CLOSING `---`,
		// so a note with a long description or many aliases — both ordinary on a
		// real project note — parsed to nothing and the caller lost every
		// platform-scoped memory, silently.
		withVault((dir) => {
			const aliases = Array.from({ length: 60 }, (_, i) => `  - a-fairly-long-alias-name-${i}`).join("\n");
			put(
				dir,
				"work/atlas.md",
				`---\ndate: 2026-07-26\ndescription: "${"padding ".repeat(80)}"\naliases:\n${aliases}\nplatforms: [ios, macos]\n---\n\n# atlas\n\nbody\n`,
			);
			assert.deepEqual(callerPlatforms(dir, "atlas", "memories"), ["ios", "macos"]);
		});
	});

	test("a project note OUTSIDE the exposed roots is still found", () => {
		// The second failed version walked the exposed files only. A vault whose
		// projects live outside a narrowed `mcp_exposed_roots` silently returned
		// no platform, and every platform-scoped memory was withheld with no
		// error anywhere.
		withVault((dir) => {
			put(dir, "work/deeply/nested/atlas.md", "---\nplatforms: [ios]\n---\n\n# A\n");
			assert.deepEqual(callerPlatforms(dir, "atlas", "memories"), ["ios"]);
		});
	});

	test("a single string platform is accepted as a one-item list", () => {
		withVault((dir) => {
			put(dir, "a/atlas.md", "---\nplatforms: ios\n---\n\n# A\n");
			assert.deepEqual(callerPlatforms(dir, "atlas", "memories"), ["ios"]);
		});
	});

	test("no note, no platforms key, and no caller all yield no platform", () => {
		withVault((dir) => {
			put(dir, "a/other.md", "---\nplatforms: [ios]\n---\n\n# O\n");
			assert.deepEqual(callerPlatforms(dir, "atlas", "memories"), [], "no note for this project");
			put(dir, "a/atlas.md", "---\ndate: 2026-07-26\n---\n\n# A\n");
			assert.deepEqual(callerPlatforms(dir, "atlas", "memories"), [], "note without the key");
			assert.deepEqual(callerPlatforms(dir, null, "memories"), [], "anonymous caller");
		});
	});
});

// ---------------------------------------------------------------------------
// Semantic ordering
// ---------------------------------------------------------------------------

describe("semantic ordering", () => {
	const VAULT = "C:/v";
	const mem = (rel: string) => ({ full: `C:/v/${rel}` });

	test("reorders the visible set to match the index", () => {
		const visible = [mem("memories/2026/07/a.md"), mem("memories/2026/07/b.md")];
		return semanticMemoryOrder(
			fakeQmd(["myvault/memories/2026/07/b.md", "myvault/memories/2026/07/a.md"]),
			VAULT,
			"q",
			visible,
			5,
		).then((r) => {
			assert.deepEqual(r?.map((m) => m.full), [visible[1]!.full, visible[0]!.full]);
		});
	});

	test("a hit the visibility rule excluded is dropped SILENTLY", async () => {
		// Not even a count: a memory scoped to another project is not a result
		// this caller asked about, so it does not enter the response at all.
		const visible = [mem("memories/2026/07/a.md")];
		const r = await semanticMemoryOrder(
			fakeQmd(["myvault/memories/2026/07/secret.md", "myvault/memories/2026/07/a.md"]),
			VAULT,
			"q",
			visible,
			5,
		);
		assert.equal(r?.length, 1);
		assert.ok(!JSON.stringify(r).includes("secret"));
	});

	test("a duplicate hit does not duplicate the memory", async () => {
		const visible = [mem("memories/2026/07/a.md")];
		const r = await semanticMemoryOrder(
			fakeQmd(["myvault/memories/2026/07/a.md", "myvault/memories/2026/07/a.md"]),
			VAULT,
			"q",
			visible,
			5,
		);
		assert.equal(r?.length, 1);
	});

	test("an index that is DOWN returns null so the caller falls back to lexical", async () => {
		// qmd is optional in this template. An unavailable index must degrade
		// ordering, never become "the vault knows nothing".
		const r = await semanticMemoryOrder(fakeQmd(null, true), VAULT, "q", [mem("memories/a.md")], 5);
		assert.equal(r, null);
	});

	test("an index with no structured results returns null rather than an empty list", async () => {
		// Returning [] would present as "no relevant memories", which is a
		// different and wrong claim.
		assert.equal(await semanticMemoryOrder(fakeQmd(null), VAULT, "q", [mem("memories/a.md")], 5), null);
	});

	test("hits that are ALL invisible return null, not an empty result", async () => {
		const r = await semanticMemoryOrder(fakeQmd(["myvault/memories/other.md"]), VAULT, "q", [mem("memories/a.md")], 5);
		assert.equal(r, null, "fall back to lexical rather than assert nothing is relevant");
	});

	test("paths with spaces join correctly against the index's dashed form", async () => {
		const visible = [{ full: "C:/v/memories/2026/07/2026-07-26 a lesson.md" }];
		const r = await semanticMemoryOrder(
			fakeQmd(["myvault/memories/2026/07/2026-07-26-a-lesson.md"]),
			VAULT,
			"q",
			visible,
			5,
		);
		assert.equal(r?.length, 1, "the index flattens spaces; the join must survive that");
	});
});
