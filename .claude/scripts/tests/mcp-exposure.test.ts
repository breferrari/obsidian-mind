/**
 * The fence, across every surface.
 *
 * The recurring defect in this layer is a SECOND read path that skips the check
 * the first one applies. It has happened twice: search proxied the whole index
 * while resources were scoped, and separately the resource enumerators read
 * `brain/` and `projects/` straight off disk, ignoring the exposed-root list
 * they were configured with.
 *
 * So the sharpest tests here assert that the surfaces AGREE — that a note
 * withheld from one is withheld from all of them. A per-surface test suite
 * would have passed throughout both incidents.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
	resolveExposure,
	isPrivate,
	firstDescription,
	isExposedPath,
	visibleFiles,
	allowedSearchPaths,
	listResources,
	resolveResourceUri,
	vaultRelKeyRaw,
} from "../lib/mcp-exposure.ts";
import { vaultRelKey } from "../lib/mcp-qmd-client.ts";

const NOTE = (desc = "a note") => `---\ndate: 2026-07-26\ndescription: "${desc}"\n---\n\n# n\n\nbody\n`;
const PRIVATE_TAG = "---\ndate: 2026-07-26\ntags:\n  - private\n---\n\n# secret\n\nbody\n";
const PRIVATE_FLAG = "---\ndate: 2026-07-26\nprivate: true\n---\n\n# secret\n\nbody\n";

function put(dir: string, rel: string, content = NOTE()): string {
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
	return full;
}

function withVault(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "exp-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A vault with an exposed folder and a sensitive one. */
function stocked(dir: string): void {
	put(dir, "brain/Gotchas.md", NOTE("things that bit us"));
	put(dir, "brain/SOUL.md", NOTE("identity"));
	put(dir, "brain/Private Thing.md", PRIVATE_TAG);
	put(dir, "reference/Arch.md");
	put(dir, "work/career/TR/Comp.md", NOTE("confidential"));
	put(dir, "people/Someone.md");
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

describe("resolving the policy", () => {
	test("an explicit declaration wins", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, { mcp_exposed_roots: ["brain", "strategy"] });
			assert.deepEqual([...p.roots], ["brain", "strategy"]);
			assert.equal(p.source, "manifest");
		});
	});

	test("a traversal root is refused; a path prefix is kept", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, { mcp_exposed_roots: ["..", "../escape", "work/active", "brain"] });
			assert.ok(!p.roots.some((r) => r.includes("..")), `${p.roots}`);
			// Path prefixes are the granularity the vault speaks in — the manifest
			// declares `work/active/`, not `work/`.
			assert.ok(p.roots.includes("work/active"));
			assert.ok(p.roots.includes("brain"));
		});
	});

	test("a FILE glob yields its parent folder; a FOLDER glob is dropped", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, {
				mcp_exposed_roots: ["brain/*.md", "perf/competencies/*.md", "perf/h*-*/", "*/anything", "reference"],
			});
			// `brain/*.md` means the notes in brain — the parent is exactly right.
			assert.ok(p.roots.includes("brain"), `${p.roots}`);
			assert.ok(p.roots.includes("perf/competencies"));
			// `perf/h*-*/` names SOME folders under perf. Truncating it to `perf`
			// would serve every folder under it, including ones never declared.
			assert.ok(!p.roots.includes("perf"), `bare perf must not appear: ${p.roots}`);
			assert.ok(!p.roots.some((r) => r.includes("*")));
			assert.ok(!p.roots.includes(""), "a leading glob contributes nothing");
		});
	});

	test("the shipped manifest resolves to exactly what it declares", () => {
		// Guards the same over-widening on the real template shape.
		withVault((dir) => {
			for (const d of ["work/active", "perf/brag", "perf/secret-draft", "brain"]) {
				mkdirSync(join(dir, d), { recursive: true });
			}
			const p = resolveExposure(dir, {
				user_content_roots: ["work/active/", "perf/brag/", "perf/h*-*/", "brain/*.md"],
			});
			assert.ok(!p.roots.includes("perf"), `${p.roots}`);
			assert.ok(p.roots.includes("perf/brag"));
			assert.ok(!p.roots.includes("perf/secret-draft"), "an undeclared sibling must not ride along");
		});
	});

	test("undeclared exposure derives from the vault's own user_content_roots", () => {
		// The user's notes, read by the user's own session. Declared at the
		// granularity the manifest uses, so work/active is served without
		// dragging in work/1-1.
		withVault((dir) => {
			for (const d of ["brain", "reference", "work/active", "work/1-1", "perf/brag"]) {
				mkdirSync(join(dir, d), { recursive: true });
			}
			const p = resolveExposure(dir, {
				user_content_roots: ["work/active/", "perf/brag/", "brain/*.md", "reference/"],
			});
			assert.equal(p.source, "derived");
			assert.ok(p.roots.includes("work/active"), `${p.roots}`);
			assert.ok(p.roots.includes("brain"));
			assert.ok(!p.roots.includes("work/1-1"), "only what the vault declared as user content");
		});
	});

	test("a declared root that does not exist on disk is dropped", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			const p = resolveExposure(dir, { user_content_roots: ["brain/", "nowhere/"] });
			assert.deepEqual([...p.roots], ["brain"]);
		});
	});

	test("a vault declaring neither key falls back", () => {
		withVault((dir) => {
			mkdirSync(join(dir, "brain"), { recursive: true });
			const p = resolveExposure(dir, {});
			assert.equal(p.source, "fallback");
			assert.deepEqual([...p.roots], ["brain"]);
		});
	});

	test("the default is NARROW — an unconfigured vault is not surprised", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, {});
			assert.ok(!p.roots.includes("work"));
			assert.ok(!p.roots.includes("people"));
			assert.ok(!p.roots.includes("journal"));
		});
	});

	test("never-expose keeps filenames with spaces and dots, which the root rule would reject", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, { mcp_never_expose: ["North Star.md", "SOUL.md"] });
			assert.ok(p.neverExpose.has("North Star.md"));
			assert.ok(p.neverExpose.has("SOUL.md"));
		});
	});

	test("never-expose ships EMPTY — the template must not impose one vault's sensitivities", () => {
		withVault((dir) => {
			assert.equal(resolveExposure(dir, {}).neverExpose.size, 0);
		});
	});
});

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

describe("private notes", () => {
	test("a private tag withholds", () => {
		withVault((dir) => assert.equal(isPrivate(put(dir, "a.md", PRIVATE_TAG)), true));
	});

	test("an explicit private flag withholds", () => {
		withVault((dir) => assert.equal(isPrivate(put(dir, "a.md", PRIVATE_FLAG)), true));
	});

	test("an ordinary note does not", () => {
		withVault((dir) => assert.equal(isPrivate(put(dir, "a.md")), false));
	});

	test("an UNREADABLE note withholds — a read error must never become an exposure", () => {
		assert.equal(isPrivate(join(tmpdir(), "definitely-not-here-xyz.md")), true);
	});

	test("a note merely CONTAINING the word private in its body is not withheld", () => {
		withVault((dir) => {
			const f = put(dir, "a.md", "---\ndate: 2026-07-26\n---\n\n# n\n\nthis is a private matter\n");
			assert.equal(isPrivate(f), false, "the marker is frontmatter, not prose");
		});
	});
});

describe("descriptions", () => {
	test("pulls the frontmatter description", () => {
		withVault((dir) => assert.equal(firstDescription(put(dir, "a.md", NOTE("hello there"))), "hello there"));
	});

	test("a note without one gets the fallback", () => {
		withVault((dir) => {
			const f = put(dir, "a.md", "---\ndate: 2026-07-26\n---\n\n# n\n");
			assert.equal(firstDescription(f), "Vault note");
		});
	});
});

// ---------------------------------------------------------------------------
// The surfaces must agree
// ---------------------------------------------------------------------------

describe("every surface applies the same fence", () => {
	test("a sensitive folder is absent from files, search paths AND resources", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain", "reference"] });

			const files = visibleFiles(dir, policy).map((f) => f.full.replace(/\\/g, "/"));
			const search = [...allowedSearchPaths(dir, policy)];
			const resources = listResources(dir, policy).map((r) => r.uri);

			for (const [surface, entries] of [
				["visibleFiles", files],
				["allowedSearchPaths", search],
				["listResources", resources],
			] as const) {
				assert.ok(!entries.some((e) => e.toLowerCase().includes("work/")), `${surface} leaked work/`);
				assert.ok(!entries.some((e) => e.toLowerCase().includes("people/")), `${surface} leaked people/`);
				assert.ok(!entries.some((e) => e.toLowerCase().includes("private")), `${surface} leaked a private note`);
			}
		});
	});

	test("EXCLUDING brain from the roots actually excludes it from resources", () => {
		// The real defect: the enumerator read brain/ off disk directly, so a vault
		// that configured the fence without brain/ still handed brain notes out.
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["reference"] });
			const resources = listResources(dir, policy);
			assert.ok(!resources.some((r) => r.uri.toLowerCase().includes("brain")), "brain/ must be gone");
			assert.ok(resources.some((r) => r.uri.toLowerCase().includes("reference")), "reference/ must remain");
		});
	});

	test("never-expose removes a file from every surface at once", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, {
				mcp_exposed_roots: ["brain"],
				mcp_never_expose: ["SOUL.md"],
			});
			assert.ok(!visibleFiles(dir, policy).some((f) => f.label === "SOUL"));
			assert.ok(!listResources(dir, policy).some((r) => r.uri.includes("SOUL")));
			assert.ok(![...allowedSearchPaths(dir, policy)].some((p) => p.includes("soul")));
		});
	});

	test("the search allow-set uses the same normalisation the search filter does", () => {
		// If these two disagreed, every note with a space in its name would be
		// permanently unsearchable while remaining readable.
		withVault((dir) => {
			put(dir, "brain/Key Decisions.md");
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			const allowed = allowedSearchPaths(dir, policy);
			assert.ok(allowed.has(vaultRelKey(dir, join(dir, "brain/Key Decisions.md"))));
			assert.ok(allowed.has("brain/key-decisions.md"));
		});
	});

	test("nested notes inside an exposed root are reached", () => {
		withVault((dir) => {
			put(dir, "reference/deep/deeper/Note.md");
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["reference"] });
			assert.equal(visibleFiles(dir, policy).length, 1);
		});
	});

	test("dotfolders inside an exposed root are skipped", () => {
		withVault((dir) => {
			put(dir, "reference/.hidden/Note.md");
			put(dir, "reference/Real.md");
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["reference"] });
			assert.deepEqual(visibleFiles(dir, policy).map((f) => f.label), ["Real"]);
		});
	});

	test("a missing exposed root is empty, not a throw", () => {
		withVault((dir) => {
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["nope"] });
			assert.deepEqual(visibleFiles(dir, policy), []);
		});
	});
});

// ---------------------------------------------------------------------------
// Memories are never ordinary notes
// ---------------------------------------------------------------------------

describe("the memory store is never part of the read surface", () => {
	/** A vault holding one memory scoped to a DIFFERENT project. */
	function withMemories(fn: (dir: string) => void, root = "memories"): void {
		withVault((dir) => {
			put(dir, "brain/Gotchas.md");
			put(
				dir,
				`${root}/2026/07/a.md`,
				"---\ndate: 2026-07-26\nsource: mcp-capture\nscope: project\nprojects: [other-app]\n---\n\n# another project private lesson\n\nbody\n",
			);
			fn(dir);
		});
	}

	test("memories/ in user_content_roots does NOT expose them", () => {
		// This is the real configuration, not a contrived one. `memories/` belongs
		// in user_content_roots because that key is what /om-vault-upgrade copies
		// across versions — leaving it out silently drops the store on upgrade.
		// Exposure derives from the same key, so doing the right thing for
		// upgrades used to expose every memory in the vault to every caller.
		withMemories((dir) => {
			const policy = resolveExposure(dir, { user_content_roots: ["brain/", "memories/"] }, "memories");
			assert.ok(!policy.roots.includes("memories"));
			assert.deepEqual(visibleFiles(dir, policy).map((f) => f.label), ["Gotchas"]);
			assert.equal(listResources(dir, policy).length, 1);
			assert.equal([...allowedSearchPaths(dir, policy)].filter((p) => p.startsWith("memories/")).length, 0);
		});
	});

	test("naming it explicitly in mcp_exposed_roots does NOT override the exclusion", () => {
		// There is no version of "serve memories as plain notes" that is safe to
		// honour: it bypasses the declared-scope rule the whole layer rests on.
		withMemories((dir) => {
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain", "memories"] }, "memories");
			assert.ok(!policy.roots.includes("memories"), "config must not be able to ask for this");
			assert.ok(!visibleFiles(dir, policy).some((f) => f.full.includes("memories")));
		});
	});

	test("a RENAMED memory root is excluded too", () => {
		// The exclusion follows the DISCOVERED root, not the configured name —
		// otherwise renaming memories/ in Obsidian silently exposes the store.
		withMemories((dir) => {
			const policy = resolveExposure(dir, { user_content_roots: ["brain/", "knowledge/"] }, "knowledge");
			assert.ok(!policy.roots.includes("knowledge"));
			assert.ok(!visibleFiles(dir, policy).some((f) => f.full.includes("knowledge")));
		}, "knowledge");
	});

	test("a hand-built policy naming the memory root still cannot walk it", () => {
		withMemories((dir) => {
			const forced = {
				roots: ["brain", "memories"],
				neverExpose: new Set<string>(),
				source: "manifest" as const,
				memoryRoot: "memories",
			};
			assert.ok(!visibleFiles(dir, forced).some((f) => f.full.includes("memories")));
			assert.equal(isExposedPath(forced, "memories/2026/07/a.md"), false);
		});
	});

	test("a memory cannot be read by URI either", () => {
		withMemories((dir) => {
			const policy = resolveExposure(dir, { user_content_roots: ["brain/", "memories/"] }, "memories");
			assert.equal(resolveResourceUri(dir, policy, "vault://note/memories/2026/07/a.md"), null);
		});
	});
});

describe("path exposure checks", () => {
	test("matches the first segment only", () => {
		const policy = { roots: ["brain"], neverExpose: new Set<string>(), source: "manifest" as const, memoryRoot: "memories" };
		assert.equal(isExposedPath(policy, "brain/Gotchas.md"), true);
		assert.equal(isExposedPath(policy, "work/brain/Secret.md"), false, "brain must not match mid-path");
		assert.equal(isExposedPath(policy, ""), false);
	});

	test("raw relative keys preserve case and spaces so a URI round-trips", () => {
		assert.equal(vaultRelKeyRaw("C:/v", "C:/v/brain/Key Decisions.md"), "brain/Key Decisions.md");
	});
});

// ---------------------------------------------------------------------------
// Resource URIs are caller input, and re-checked
// ---------------------------------------------------------------------------

describe("resolving a resource URI", () => {
	test("a legal URI resolves to the file", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			const uri = listResources(dir, policy).find((r) => r.uri.includes("Gotchas"))!.uri;
			assert.ok(resolveResourceUri(dir, policy, uri));
		});
	});

	test("a URI naming an out-of-scope note is refused even though it is well-formed", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			assert.equal(resolveResourceUri(dir, policy, "vault://note/work/career/TR/Comp.md"), null);
		});
	});

	test("traversal is refused, encoded or not", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			for (const bad of [
				"vault://note/../../../etc/passwd",
				"vault://note/brain/../../work/career/TR/Comp.md",
				"vault://note/%2e%2e/%2e%2e/work/career/TR/Comp.md",
				"vault://note//etc/passwd",
				"vault://note/C:/Windows/system.ini",
			]) {
				assert.equal(resolveResourceUri(dir, policy, bad), null, `refused: ${bad}`);
			}
		});
	});

	test("a private note is refused even when its folder is exposed", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			assert.equal(resolveResourceUri(dir, policy, "vault://note/brain/Private Thing.md"), null);
		});
	});

	test("a never-expose filename is refused by URI too", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"], mcp_never_expose: ["SOUL.md"] });
			assert.equal(resolveResourceUri(dir, policy, "vault://note/brain/SOUL.md"), null);
		});
	});

	test("a SYMLINK out of an exposed folder is refused", () => {
		// `resolve` collapses `..` but happily returns a path whose real target is
		// outside the vault. A link planted in an exposed folder would otherwise
		// read anything this process can. MCPVault shipped this bug for real.
		withVault((dir) => {
			stocked(dir);
			const outside = put(dir, "..-outside/secret.md", NOTE("should never be readable"));
			const link = join(dir, "brain", "innocent.md");
			try {
				symlinkSync(outside, link, "file");
			} catch {
				// Windows without developer mode cannot create symlinks; the guard is
				// still compiled and exercised by the traversal cases above.
				return;
			}
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			assert.equal(
				resolveResourceUri(dir, policy, "vault://note/brain/innocent.md"),
				null,
				"a link whose target escapes the exposed root must not resolve",
			);
		});
	});

	test("a nonexistent note and a foreign scheme are both null", () => {
		withVault((dir) => {
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			assert.equal(resolveResourceUri(dir, policy, "vault://note/brain/Ghost.md"), null);
			assert.equal(resolveResourceUri(dir, policy, "file:///etc/passwd"), null);
			assert.equal(resolveResourceUri(dir, policy, "vault://other/brain/Gotchas.md"), null);
		});
	});
});
