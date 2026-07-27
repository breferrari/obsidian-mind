/**
 * The memory-store parse cache.
 *
 * A cache on the retrieval path is only as good as the moment it decides to stop
 * trusting itself, so almost every test here is about INVALIDATION rather than
 * about hits.
 *
 * The load-bearing property, asserted directly: what the cache returns is what
 * reading the store from disk returns. Every other test is a way for that to
 * stop being true.
 *
 * One limit is asserted rather than defended: `(size, mtime)` is a change hint,
 * not a content hash, so an edit preserving both is invisible here. That is why
 * the duplicate scan reads from disk instead of through this — a test below
 * pins both halves of that split.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	unlinkSync,
	utimesSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { createMemoryIndex } from "../lib/memory-index.ts";
import { readMemories, recall, recallFrom, agentMemories, MEMORY_SOURCE } from "../lib/memory-recall.ts";
import { loadMemoryDigests, digestsFrom } from "../lib/mcp-memory-bridge.ts";

const ROOT = "memories";

function withVault(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "memidx-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function memory(dir: string, name: string, body = "the body.", extra = ""): string {
	const rel = `${ROOT}/2026/07/${name}.md`;
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(
		full,
		`---\ndate: 2026-07-26\nsource: ${MEMORY_SOURCE}\nscope: general\nconfidence: verified\n${extra}\n---\n\n# ${name}\n\n${body}\n`,
		"utf8",
	);
	return full;
}

const titles = (entries: readonly { title: string | null }[]): string[] =>
	entries.map((e) => e.title ?? "").sort();

// ---------------------------------------------------------------------------
// Equivalence — the property everything else protects
// ---------------------------------------------------------------------------

describe("the cache agrees with the filesystem", () => {
	test("returns exactly what reading the store returns", () => {
		withVault((dir) => {
			for (const n of ["a", "b", "c"]) memory(dir, n);
			const idx = createMemoryIndex(dir, ROOT);
			assert.deepEqual(
				idx.all().map((m) => ({ rel: m.rel, title: m.title, body: m.body, facets: m.facets })),
				readMemories(dir, ROOT).map((m) => ({ rel: m.rel, title: m.title, body: m.body, facets: m.facets })),
			);
		});
	});

	test("recall through the cache equals recall from disk", () => {
		withVault((dir) => {
			memory(dir, "shared");
			memory(dir, "scoped", "body", "projects: [atlas]");
			const idx = createMemoryIndex(dir, ROOT);
			const caller = { project: "atlas", platforms: [] as string[] };
			assert.deepEqual(recallFrom(idx.all(), caller), recall(dir, caller, { root: ROOT }));
		});
	});

	test("the duplicate scan sees the same digests either way", () => {
		withVault((dir) => {
			memory(dir, "one");
			memory(dir, "two");
			const idx = createMemoryIndex(dir, ROOT);
			assert.deepEqual(digestsFrom(idx.all()), loadMemoryDigests(dir, ROOT));
		});
	});
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

describe("noticing that the store changed", () => {
	test("a second call is served from cache", () => {
		withVault((dir) => {
			for (const n of ["a", "b"]) memory(dir, n);
			const idx = createMemoryIndex(dir, ROOT);
			idx.all();
			assert.deepEqual({ h: idx.stats.hits, m: idx.stats.misses }, { h: 0, m: 2 }, "first call parses");
			idx.all();
			assert.deepEqual({ h: idx.stats.hits, m: idx.stats.misses }, { h: 2, m: 0 }, "second call reuses");
		});
	});

	test("an EDITED memory is re-parsed, not served stale", () => {
		// The whole risk in one case. A supersession rewrites frontmatter in place,
		// and serving the previous parse would keep a retired memory outranking the
		// correction that replaced it.
		withVault((dir) => {
			memory(dir, "a", "original body");
			const idx = createMemoryIndex(dir, ROOT);
			assert.match(idx.all()[0]!.body, /original body/);

			memory(dir, "a", "corrected body that is a different length entirely");
			const after = idx.all();
			assert.match(after[0]!.body, /corrected body/, "the edit must be visible");
			assert.equal(idx.stats.misses, 1, "and it must have been re-parsed");
		});
	});

	test("an edit that preserves SIZE is still caught, via mtime", () => {
		withVault((dir) => {
			const full = memory(dir, "a", "aaaa");
			const idx = createMemoryIndex(dir, ROOT);
			idx.all();
			// Same byte length, different content — size alone would miss this.
			memory(dir, "a", "bbbb");
			const st = statSync(full);
			utimesSync(full, st.atime, new Date(st.mtimeMs + 5000));
			assert.match(idx.all()[0]!.body, /bbbb/);
		});
	});

	test("an edit that preserves MTIME is still caught, via size", () => {
		// Some filesystems keep mtime to a whole second, so two writes inside one
		// second can carry an identical timestamp.
		withVault((dir) => {
			const full = memory(dir, "a", "short");
			const idx = createMemoryIndex(dir, ROOT);
			idx.all();
			const before = statSync(full);
			memory(dir, "a", "a considerably longer body than the one before it");
			utimesSync(full, before.atime, before.mtime);
			assert.match(idx.all()[0]!.body, /considerably longer/);
		});
	});

	test("invalidate forces a re-parse even when nothing on disk looks different", () => {
		// The belt to the size+mtime braces: writers call this, so correctness never
		// rests on timestamp resolution.
		withVault((dir) => {
			memory(dir, "a");
			const idx = createMemoryIndex(dir, ROOT);
			const [first] = idx.all();
			idx.invalidate(first!.rel);
			idx.all();
			assert.equal(idx.stats.misses, 1);
			assert.equal(idx.stats.hits, 0);
		});
	});

	test("the duplicate-scan path sees an edit the cache is not guaranteed to", () => {
		// `(size, mtime)` is a change hint, not a content hash: `rsync -t`, `tar -p`,
		// `unzip`, a sync client and a second-granularity filesystem all produce
		// same-size, same-mtime, different-bytes. Whether THIS filesystem happens to
		// collide is not something a test can force portably — restoring an mtime
		// through a Date loses sub-millisecond precision, so it does not collide
		// here — so the assertion is on the guarantee that does hold: the path
		// `remember` uses reads from disk, and therefore always reflects the file.
		withVault((dir) => {
			const full = memory(dir, "a", "aaaa");
			const before = statSync(full);
			memory(dir, "a", "bbbb"); // identical length
			utimesSync(full, before.atime, before.mtime);

			assert.match(
				readMemories(dir, ROOT)[0]!.body,
				/bbbb/,
				"the duplicate scan must never be able to miss a write",
			);
		});
	});

	test("a symlinked year folder is walked, not silently skipped", () => {
		// A Dirent reports a link-to-directory as isSymbolicLink() and NOT
		// isDirectory(), so filtering on isDirectory() alone drops every memory
		// under `memories/2025 -> /somewhere/archive` — from recall, from the
		// duplicate scan and from health, with no warning anywhere.
		withVault((dir) => {
			memory(dir, "live");
			const archive = join(dir, "archived-elsewhere", "07");
			mkdirSync(archive, { recursive: true });
			writeFileSync(
				join(archive, "old.md"),
				`---\ndate: 2025-07-01\nsource: ${MEMORY_SOURCE}\nscope: general\nconfidence: verified\n---\n\n# old\n\nbody.\n`,
				"utf8",
			);
			try {
				symlinkSync(join(dir, "archived-elsewhere"), join(dir, ROOT, "2025"), "junction");
			} catch {
				return; // Windows without developer mode
			}
			assert.deepEqual(titles(createMemoryIndex(dir, ROOT).all()), ["live", "old"]);
		});
	});

	test("a NEW memory appears without any explicit invalidation", () => {
		withVault((dir) => {
			memory(dir, "a");
			const idx = createMemoryIndex(dir, ROOT);
			assert.equal(idx.all().length, 1);
			memory(dir, "b");
			assert.deepEqual(titles(idx.all()), ["a", "b"]);
		});
	});

	test("a DELETED memory disappears, and stops being held", () => {
		withVault((dir) => {
			const full = memory(dir, "a");
			memory(dir, "b");
			const idx = createMemoryIndex(dir, ROOT);
			assert.equal(idx.all().length, 2);
			unlinkSync(full);
			assert.deepEqual(titles(idx.all()), ["b"]);
			assert.equal(idx.stats.size, 1, "the cache tracks the store rather than growing forever");
		});
	});

	test("an emptied store returns nothing and holds nothing", () => {
		withVault((dir) => {
			const full = memory(dir, "only");
			const idx = createMemoryIndex(dir, ROOT);
			idx.all();
			unlinkSync(full);
			assert.deepEqual(idx.all(), []);
			assert.equal(idx.stats.size, 0);
		});
	});
});

// ---------------------------------------------------------------------------
// What counts as a memory
// ---------------------------------------------------------------------------

describe("policy stays with the caller", () => {
	test("the cache returns human notes too; agentMemories is what filters", () => {
		// Deliberate: a cache that encoded "is this a memory" would have to be
		// rebuilt whenever that rule moved.
		withVault((dir) => {
			memory(dir, "written-by-an-agent");
			const rel = join(dir, ROOT, "2026", "07", "mine.md");
			mkdirSync(dirname(rel), { recursive: true });
			writeFileSync(rel, "---\ndate: 2026-07-26\ntags: [note]\n---\n\n# mine\n\nhand written\n", "utf8");

			const idx = createMemoryIndex(dir, ROOT);
			const all = idx.all();
			assert.equal(all.length, 2, "both are cached");
			assert.deepEqual(titles(agentMemories(all)), ["written-by-an-agent"]);
		});
	});

	test("an empty store is an empty list, not a throw", () => {
		withVault((dir) => assert.deepEqual(createMemoryIndex(dir, ROOT).all(), []));
	});

	test("a missing memory root is an empty list", () => {
		withVault((dir) => assert.deepEqual(createMemoryIndex(dir, "nowhere").all(), []));
	});
});
