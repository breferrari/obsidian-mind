/**
 * Discovery and self-healing.
 *
 * Every defect this module exists to catch is SILENT: a renamed folder, a moved
 * launcher, an index registered against someone else's vault and a store that
 * has forked in two all present identically as "no results". So the assertions
 * here are mostly about the *diagnostic* — that the layer notices, says which
 * state it is in, and names the fix — not merely that it returns a value.
 *
 * The known-negative cases are load-bearing: an unregistered index and a project
 * with no note in the vault are both NORMAL, and a diagnostic that flags them as
 * faults sends the reader hunting for a break that does not exist.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
	walkMarkdown,
	probeFrontmatter,
	discoverMemoryRoot,
	discoverExposedRoots,
	discoverQmdLauncher,
	findOrphanedProjects,
	readIndexPath,
	samePath,
	indexOwnershipWarning,
	health,
	type IndexPathInfo,
} from "../lib/memory-discover.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tmpVault(): string {
	return mkdtempSync(join(tmpdir(), "disc-"));
}

/** Write a file, creating parents. Content defaults to a real capture. */
function put(dir: string, rel: string, content?: string): string {
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content ?? capture(), "utf8");
	return full;
}

function capture(projects: string[] = ["atlas"]): string {
	return [
		"---",
		"date: 2026-07-26",
		"source: mcp-capture",
		"scope: project",
		`projects: [${projects.join(", ")}]`,
		"---",
		"",
		"# a memory",
		"",
		"body",
		"",
	].join("\n");
}

/** A note a human wrote. Must never be mistaken for a capture. */
const HUMAN = "---\ndate: 2026-07-26\ntags:\n  - project-note\n---\n\n# hand written\n\nbody\n";

function withVault(fn: (dir: string) => void): void {
	const dir = tmpVault();
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

describe("walking", () => {
	test("finds markdown and ignores everything else", () => {
		withVault((dir) => {
			put(dir, "brain/a.md", HUMAN);
			put(dir, "brain/b.txt", "not markdown");
			put(dir, "brain/c.MD", HUMAN);
			const found = walkMarkdown(dir).map((f) => f.toLowerCase());
			assert.equal(found.length, 2);
			assert.ok(found.some((f) => f.endsWith("a.md")));
			assert.ok(found.some((f) => f.endsWith("c.md")), "extension match is case-insensitive");
		});
	});

	test("never walks into infrastructure directories", () => {
		withVault((dir) => {
			put(dir, "node_modules/pkg/readme.md", HUMAN);
			put(dir, ".git/x.md", HUMAN);
			put(dir, ".obsidian/y.md", HUMAN);
			// The bundled template copy is a whole second vault; walking it would
			// double every count in this module.
			put(dir, ".shardmind/template/brain/z.md", HUMAN);
			put(dir, "brain/real.md", HUMAN);
			const found = walkMarkdown(dir);
			assert.equal(found.length, 1);
			assert.ok(found[0]!.endsWith("real.md"));
		});
	});

	test("depth is bounded, so a pathological tree cannot hang startup", () => {
		withVault((dir) => {
			put(dir, "a/b/c/d/e/f/g/deep.md", HUMAN);
			assert.equal(walkMarkdown(dir, { maxDepth: 2 }).length, 0);
			assert.equal(walkMarkdown(dir, { maxDepth: 8 }).length, 1);
		});
	});

	test("a missing root is empty, not a throw", () => {
		assert.deepEqual(walkMarkdown(join(tmpdir(), "does-not-exist-at-all")), []);
	});
});

describe("frontmatter probe", () => {
	test("returns the block for a note that has one", () => {
		withVault((dir) => {
			const f = put(dir, "m.md");
			assert.match(String(probeFrontmatter(f)), /source: mcp-capture/);
		});
	});

	test("a note with no frontmatter is null rather than an error", () => {
		withVault((dir) => {
			const f = put(dir, "plain.md", "# just a heading\n");
			assert.equal(probeFrontmatter(f), null);
		});
	});

	test("an unreadable path is null rather than an error", () => {
		assert.equal(probeFrontmatter(join(tmpdir(), "nope-nope.md")), null);
	});
});

// ---------------------------------------------------------------------------
// Memory root — the rename case
// ---------------------------------------------------------------------------

describe("discovering the memory root", () => {
	test("an empty vault trusts config, because there is nothing to be wrong about", () => {
		withVault((dir) => {
			const r = discoverMemoryRoot(dir, "memories");
			assert.equal(r.root, "memories");
			assert.equal(r.source, "configured");
			assert.equal(r.memories, 0);
			assert.equal(r.healed, false);
			assert.equal(r.split, null);
		});
	});

	test("config that matches reality is reported as configured, not discovered", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md");
			const r = discoverMemoryRoot(dir, "memories");
			assert.equal(r.root, "memories");
			assert.equal(r.source, "configured");
			assert.equal(r.healed, false);
		});
	});

	test("a user renaming the folder in Obsidian is followed, and said out loud", () => {
		withVault((dir) => {
			// The whole point: config still says `memories`, the notes say otherwise.
			put(dir, "knowledge/2026/07/a.md");
			put(dir, "knowledge/2026/07/b.md");
			const r = discoverMemoryRoot(dir, "memories");
			assert.equal(r.root, "knowledge", "follow the notes, not the config");
			assert.equal(r.source, "discovered");
			assert.equal(r.healed, true, "healing must be visible — silence is how a store forks");
			assert.equal(r.configured, "memories");
			assert.equal(r.memories, 2);
		});
	});

	test("only agent captures count — a human note cannot move the root", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md");
			put(dir, "journal/x.md", HUMAN);
			put(dir, "journal/y.md", HUMAN);
			put(dir, "journal/z.md", HUMAN);
			assert.equal(discoverMemoryRoot(dir, "memories").root, "memories");
		});
	});

	test("an incomplete move is named, because retrieval only sees the larger half", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md");
			put(dir, "memories/2026/07/b.md");
			put(dir, "knowledge/2026/07/c.md");
			const r = discoverMemoryRoot(dir, "memories");
			assert.equal(r.root, "memories");
			assert.ok(r.split, "a split store must be reported");
			assert.equal(r.split!.length, 2);
			const knowledge = r.split!.find((s) => s.root === "knowledge");
			assert.equal(knowledge?.memories, 1);
		});
	});

	test("a capture at the vault root is ignored — the root is not a memory folder", () => {
		withVault((dir) => {
			put(dir, "loose.md");
			const r = discoverMemoryRoot(dir, "memories");
			assert.equal(r.memories, 0);
			assert.equal(r.root, "memories");
		});
	});
});

// ---------------------------------------------------------------------------
// Exposed roots
// ---------------------------------------------------------------------------

describe("discovering exposed roots", () => {
	test("derives from the manifest key the template already maintains", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			mkdirSync(join(dir, "reference"), { recursive: true });
			const r = discoverExposedRoots(dir, { user_content_roots: ["brain/", "reference/"] });
			assert.deepEqual(r.roots.sort(), ["brain", "reference"]);
			assert.equal(r.source, "manifest");
		});
	});

	test("a declared root that does not exist is dropped, not exposed", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			const r = discoverExposedRoots(dir, { user_content_roots: ["brain/", "strategy/"] });
			assert.deepEqual(r.roots, ["brain"]);
		});
	});

	test("a glob entry contributes its literal segment, never everything", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "perf"), { recursive: true });
			const r = discoverExposedRoots(dir, { user_content_roots: ["perf/h*-*/", "*/"] });
			assert.deepEqual(r.roots, ["perf"], "a leading-glob entry must contribute nothing");
		});
	});

	test("no usable manifest falls back, and says so, so health can warn", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			const r = discoverExposedRoots(dir, {});
			assert.equal(r.source, "fallback");
			assert.deepEqual(r.roots, ["brain"]);
		});
	});

	test("a null manifest is a fallback, not a crash", () => {
		withVault((dir) => {
			assert.equal(discoverExposedRoots(dir, null).source, "fallback");
		});
	});
});

// ---------------------------------------------------------------------------
// qmd launcher
// ---------------------------------------------------------------------------

describe("locating the qmd launcher", () => {
	test("the expected path is used without a walk", () => {
		withVault((dir) => {
			put(dir, ".claude/scripts/qmd-mcp.mjs", "//");
			const r = discoverQmdLauncher(dir);
			assert.equal(r.source, "expected");
			assert.ok(r.path);
		});
	});

	test("a moved launcher is still found — the layout is allowed to change", () => {
		withVault((dir) => {
			// #71 moves hook scripts out of .claude/; hardcoding the old path would
			// silently disable search the day that lands.
			put(dir, ".scripts/qmd-mcp.mjs", "//");
			const r = discoverQmdLauncher(dir);
			assert.equal(r.source, "discovered");
			assert.ok(r.path!.endsWith("qmd-mcp.mjs"));
		});
	});

	test("absent is a legitimate state — qmd is optional", () => {
		withVault((dir) => {
			const r = discoverQmdLauncher(dir);
			assert.equal(r.source, "absent");
			assert.equal(r.path, null);
		});
	});
});

// ---------------------------------------------------------------------------
// Project names — a diagnostic that must not lie
// ---------------------------------------------------------------------------

describe("projects with no note in the vault", () => {
	test("reports a name nothing in the vault refers to", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md", capture(["atlas-old"]));
			const r = findOrphanedProjects(dir, "memories", ["atlas", "beacon"]);
			assert.equal(r.length, 1);
			assert.equal(r[0]!.project, "atlas-old");
			assert.equal(r[0]!.memories, 1);
		});
	});

	test("a known project is never reported", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md", capture(["atlas"]));
			assert.deepEqual(findOrphanedProjects(dir, "memories", ["Atlas"]), [], "match is case-insensitive");
		});
	});

	test("counts accumulate per name", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md", capture(["ghost"]));
			put(dir, "memories/2026/07/b.md", capture(["ghost"]));
			assert.equal(findOrphanedProjects(dir, "memories", [])[0]!.memories, 2);
		});
	});

	test("a missing memory root is empty, not a throw", () => {
		withVault((dir) => {
			assert.deepEqual(findOrphanedProjects(dir, "memories", []), []);
		});
	});
});

// ---------------------------------------------------------------------------
// Index ownership — the last silent-loss path
// ---------------------------------------------------------------------------

describe("index ownership", () => {
	const HOME = "/home/x";
	const j = (...p: string[]): string => p.join("/");
	const reader =
		(map: Record<string, string>) =>
		(f: string): string => {
			const v = map[f];
			if (v === undefined) throw new Error("ENOENT");
			return v;
		};

	test("reads the registered path out of qmd's per-index config", () => {
		const r = readIndexPath(
			"myvault",
			HOME,
			reader({
				"/home/x/.config/qmd/myvault.yml": "collections:\n  myvault:\n    path: C:\\Dev\\myvault\n",
			}),
			j,
		);
		assert.equal(r.state, "registered");
		assert.equal(r.path, String.raw`C:\Dev\myvault`);
	});

	test("an unregistered index is NOT a warning — that is a fresh vault", () => {
		const info = readIndexPath("fresh", HOME, reader({}), j);
		assert.equal(info.state, "unregistered");
		assert.equal(indexOwnershipWarning("fresh", "C:/Dev/fresh", info), null);
	});

	test("a collection pointing at THIS vault is silent", () => {
		const info: IndexPathInfo = { state: "registered", path: String.raw`C:\Dev\myvault` };
		assert.equal(indexOwnershipWarning("myvault", "C:/Dev/myvault", info), null);
	});

	test("a collection pointing at ANOTHER vault warns and names it", () => {
		// Exactly the #137 collision: two vaults sharing one index name, so
		// reindexing silently updates the wrong tree.
		const info: IndexPathInfo = { state: "registered", path: String.raw`C:\Dev\obsidian-mind` };
		const w = indexOwnershipWarning("obsidian-mind", "C:/Dev/sandbox/e2e-om", info);
		assert.ok(w, "must warn");
		assert.match(w!, /DIFFERENT vault/);
		assert.ok(w!.includes(String.raw`C:\Dev\obsidian-mind`), "must name the vault it actually points at");
		assert.match(w!, /qmd_index/, "must name the fix");
	});

	test("path comparison ignores separator style and case", () => {
		assert.equal(samePath(String.raw`C:\Dev\Vault`, "c:/dev/vault"), true);
		assert.equal(samePath("C:/Dev/vault/", "C:/Dev/vault"), true);
		assert.equal(samePath("C:/Dev/vault", "C:/Dev/other"), false);
	});

	test("a malformed config degrades to a warning, not a wrong answer", () => {
		const info = readIndexPath("bad", HOME, reader({ "/home/x/.config/qmd/bad.yml": "nonsense" }), j);
		assert.equal(info.state, "malformed");
		assert.match(String(indexOwnershipWarning("bad", "C:/Dev/x", info)), /cannot be confirmed/);
	});

	test("no index name at all is unknown, and never warns", () => {
		const info = readIndexPath(null, HOME, reader({}), j);
		assert.equal(info.state, "unknown");
		assert.equal(indexOwnershipWarning("", "C:/Dev/x", info), null);
	});
});

// ---------------------------------------------------------------------------
// Health — every silent state becomes a sentence
// ---------------------------------------------------------------------------

describe("health", () => {
	test("a correctly wired vault is ok and warns about nothing", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			put(dir, ".claude/scripts/qmd-mcp.mjs", "//");
			put(dir, "memories/2026/07/a.md", capture(["atlas"]));
			const h = health(dir, { user_content_roots: ["brain/"], memory_root: "memories" }, {
				knownNames: ["atlas"],
			});
			assert.deepEqual(h.warnings, []);
			assert.equal(h.ok, true);
		});
	});

	test("a renamed memory folder produces a warning that names the fix", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			put(dir, ".claude/scripts/qmd-mcp.mjs", "//");
			put(dir, "knowledge/2026/07/a.md");
			const h = health(dir, { user_content_roots: ["brain/"], memory_root: "memories" });
			assert.equal(h.ok, false);
			const w = h.warnings.join(" ");
			assert.match(w, /knowledge/);
			assert.match(w, /memory_root/, "a warning without the remedy is half a diagnostic");
		});
	});

	test("a missing qmd launcher warns but does not claim the vault is empty", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			const h = health(dir, { user_content_roots: ["brain/"] });
			assert.match(h.warnings.join(" "), /lexical/, "degradation must be described, not implied");
		});
	});

	test("a project with no note is a NOTE, never a warning", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			put(dir, ".claude/scripts/qmd-mcp.mjs", "//");
			put(dir, "memories/2026/07/a.md", capture(["ghost"]));
			const h = health(dir, { user_content_roots: ["brain/"], memory_root: "memories" }, {
				knownNames: ["atlas"],
			});
			// A repo needs no note in the vault for its memories to reach it. Calling
			// this a fault would send the reader hunting for a break that is not there.
			assert.deepEqual(h.warnings, []);
			assert.equal(h.ok, true);
			assert.equal(h.notes.length, 1);
			assert.match(h.notes[0]!, /ghost/);
			assert.match(h.notes[0]!, /renamed/, "must point at the case where it IS a real signal");
		});
	});

	test("singular and plural read correctly in the notes", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md", capture(["ghost"]));
			put(dir, "memories/2026/07/b.md", capture(["ghost"]));
			const one = health(dir, { memory_root: "memories" }, { knownNames: [] });
			assert.match(one.notes[0]!, /2 memories scoped/);
		});
	});

	test("an unconfigured manifest still works — memory_root defaults", () => {
		withVault((dir) => {
			put(dir, "memories/2026/07/a.md");
			const h = health(dir, null);
			assert.equal(h.memory.root, "memories");
			assert.equal(h.memory.healed, false);
		});
	});

	test("index ownership is folded into the same report", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			put(dir, ".claude/scripts/qmd-mcp.mjs", "//");
			// A home with no qmd config at all: unregistered, which must stay quiet.
			const h = health(dir, { user_content_roots: ["brain/"] }, {
				indexName: "whatever",
				home: join(dir, "fake-home"),
			});
			assert.deepEqual(h.warnings, []);
		});
	});
});
