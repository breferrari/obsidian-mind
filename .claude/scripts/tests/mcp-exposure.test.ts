/**
 * The exposure policy, across every surface.
 *
 * The failure this suite is shaped around is a SECOND read path that skips the
 * check the first one applies — a surface that walks the vault itself instead of
 * resolving through `visibleFiles`, and so ignores the configured roots.
 *
 * So the sharpest tests here assert that the surfaces AGREE: a note absent from
 * one is absent from all of them. A per-surface suite passes even when they have
 * drifted apart, which is exactly the state worth catching.
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
	isNeverExposed,
} from "../lib/mcp-exposure.ts";
import type { ExposurePolicy } from "../lib/mcp-exposure.ts";
import { vaultRelKey } from "../lib/mcp-qmd-client.ts";

const NL = String.fromCharCode(10);

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

/** A vault with a declared root, undeclared ones, and a note tagged private. */
function stocked(dir: string): void {
	put(dir, "brain/Gotchas.md", NOTE("things that bit us"));
	put(dir, "brain/SOUL.md", NOTE("identity"));
	put(dir, "brain/Private Thing.md", PRIVATE_TAG);
	put(dir, "reference/Arch.md");
	put(dir, "work/1-1/Sarah.md", NOTE("a 1:1 note"));
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

	/**
	 * Both directions, because fixing this in one direction caused the other.
	 *
	 * `readHead` stops at 1200 characters, so a `private:` past that point was
	 * never seen and the note was served. The first fix withheld any note whose
	 * frontmatter did not close inside the prefix — which failed closed and made
	 * two ordinary public notes in a real vault vanish from `search`, `expand`
	 * and the resource listing, silently, with the set growing as frontmatter
	 * grows. The guard looks further now instead of guessing either way.
	 */
	test("a private marker past the head window still withholds", () => {
		withVault((dir) => {
			const filler = Array.from({ length: 120 }, (_, i) => "  - alias-" + i).join(NL);
			const full = put(dir, "brain/Deep Private.md", "---" + NL + "aliases:" + NL + filler + NL + "private: true" + NL + "---" + NL + NL + "# d" + NL);
			assert.ok(isPrivate(full), "the marker is past char 1200 but it is still a marker");
		});
	});

	test("a public note with long frontmatter is STILL SERVED", () => {
		withVault((dir) => {
			const filler = Array.from({ length: 120 }, (_, i) => "  - alias-" + i).join(NL);
			const full = put(dir, "brain/Deep Public.md", "---" + NL + "aliases:" + NL + filler + NL + "---" + NL + NL + "# d" + NL);
			assert.ok(!isPrivate(full), "long frontmatter is not a privacy signal");
		});
	});

	test("a note with no frontmatter is served, and a bare rule is not frontmatter", () => {
		withVault((dir) => {
			assert.ok(!isPrivate(put(dir, "brain/Plain.md", "# t" + NL + NL + "body" + NL)));
			assert.ok(!isPrivate(put(dir, "brain/Rule.md", "# t" + NL + NL + "---" + NL + NL + "after" + NL)));
		});
	});

	test("frontmatter that never closes is withheld", () => {
		withVault((dir) => {
			const filler = Array.from({ length: 5000 }, (_, i) => "  - alias-" + i).join(NL);
			const full = put(dir, "brain/Runaway.md", "---" + NL + "aliases:" + NL + filler + NL);
			assert.ok(isPrivate(full), "a block that never closes is not a block this can judge");
		});
	});

	test("never-expose keeps filenames with spaces and dots, which the root rule would reject", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, { mcp_never_expose: ["North Star.md", "SOUL.md"] });
			// Asserted through the predicate rather than on the set's own spelling:
			// the set's internal case is an implementation detail, and a test that
			// pins it breaks on the very normalisation that closes the bypass below.
			assert.ok(isNeverExposed(p, "brain/North Star.md"));
			assert.ok(isNeverExposed(p, "brain/SOUL.md"));
		});
	});

	/**
	 * The bypass, and the shape of it.
	 *
	 * The admit side has always compared case-insensitively; the withhold side
	 * was exact-case. On any case-insensitive filesystem that asymmetry served
	 * the file: `mcp_never_expose: ["SOUL.md"]` refused `brain/SOUL.md` and
	 * returned 44KB for `brain/soul.md`. The listing withheld it while the reader
	 * served it — the two-surfaces-disagree defect, inverted — and `realpathSync`
	 * on Windows does not canonicalise case, so the post-realpath re-check saw
	 * the caller's spelling too.
	 */
	test("never-expose withholds every case spelling, not the one that was typed", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, { mcp_never_expose: ["SOUL.md"] });
			for (const spelling of ["SOUL.md", "soul.md", "Soul.md", "SoUl.MD", "sOuL.Md"]) {
				assert.ok(isNeverExposed(p, `brain/${spelling}`), spelling);
			}
		});
	});

	test("never-expose does not depend on how the policy was constructed", () => {
		// Every test — and any caller assembling one by hand — builds a policy
		// literal. Normalising only in `resolveExposure` would leave those failing
		// OPEN, which is the same split invariant the bypass came from.
		const handBuilt: ExposurePolicy = {
			roots: ["brain"],
			neverExpose: new Set(["SOUL.md"]),
			source: "manifest",
			memoryRoot: "memories",
		};
		assert.ok(isNeverExposed(handBuilt, "brain/soul.md"));
		assert.ok(isNeverExposed(handBuilt, "brain/SOUL.md"));
	});

	/**
	 * PLATFORM-DEPENDENT, and worth saying so rather than letting it read as
	 * universal coverage. On Windows `path.basename` is the win32 implementation
	 * and already splits backslashes, so this assertion passes with or without
	 * the normalisation — mutation-checked, and the mutant survives here. It has
	 * teeth only on POSIX, where a backslash is an ordinary filename character
	 * and `basename("brain\\SOUL.md")` returns the whole string. Linux CI is what
	 * enforces it.
	 */
	test("never-expose normalises separators before taking the basename", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, { mcp_never_expose: ["SOUL.md"] });
			assert.ok(isNeverExposed(p, String.raw`brain\SOUL.md`), "a backslash path must still yield the filename");
		});
	});

	test("a path that is not withheld stays servable", () => {
		withVault((dir) => {
			const p = resolveExposure(dir, { mcp_never_expose: ["SOUL.md"] });
			assert.ok(!isNeverExposed(p, "brain/Gotchas.md"));
			assert.ok(!isNeverExposed(p, "brain/SOULFUL.md"), "a prefix is not a match");
			assert.ok(!isNeverExposed(p, ""));
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

describe("every surface applies the same policy", () => {
	test("an undeclared folder is absent from files, search paths AND resources", () => {
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
				assert.ok(!entries.some((e) => e.toLowerCase().includes("work/")), `${surface} served work/`);
				assert.ok(!entries.some((e) => e.toLowerCase().includes("people/")), `${surface} served people/`);
				assert.ok(!entries.some((e) => e.toLowerCase().includes("private")), `${surface} served a private note`);
			}
		});
	});

	test("EXCLUDING brain from the roots actually excludes it from resources", () => {
		// The real defect: the enumerator read brain/ off disk directly, so a vault
		// that declared roots WITHOUT brain/ still listed brain notes.
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
			assert.equal(resolveResourceUri(dir, policy, "vault://note/work/1-1/Sarah.md"), null);
		});
	});

	// `search` reports qmd's collection-prefixed paths, so a caller that pastes one
	// into a resource URI used to get an undiagnosable not-found. Observed for real
	// on vigia's first session, which burned a round trip guessing the right form.
	test("a collection-prefixed URI resolves when the collection is supplied", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			const uri = listResources(dir, policy).find((r) => r.uri.includes("Gotchas"))!.uri;
			const prefixed = uri.replace("vault://note/", "vault://note/myvault/");

			assert.equal(resolveResourceUri(dir, policy, prefixed), null, "refused without the collection");
			assert.equal(
				resolveResourceUri(dir, policy, prefixed, "myvault"),
				resolveResourceUri(dir, policy, uri),
				"resolves to the same file once the collection is known",
			);
		});
	});

	// The prefix was only half of it. qmd replaces spaces with dashes in directory
	// names as well as filenames, so a path copied out of a search result names a
	// file that does not exist. This is what actually denied vigia's first read.
	test("a slugified path resolves back to the real file, directories included", () => {
		withVault((dir) => {
			stocked(dir);
			put(dir, "reference/Deep Folder/A Long Note.md", NOTE("real one"));
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain", "reference"] });

			const truth = resolveResourceUri(dir, policy, "vault://note/reference/Deep Folder/A Long Note.md");
			assert.ok(truth, "sanity: the true path resolves");

			// Slug in the filename, slug in the directory, and both behind the prefix.
			for (const uri of [
				"vault://note/reference/Deep Folder/A-Long-Note.md",
				"vault://note/reference/Deep-Folder/A-Long-Note.md",
				"vault://note/myvault/reference/Deep-Folder/A-Long-Note.md",
			]) {
				assert.equal(resolveResourceUri(dir, policy, uri, "myvault"), truth, uri);
			}
		});
	});

	test("an ambiguous slug is refused rather than guessed", () => {
		withVault((dir) => {
			// Two sibling directories that slugify to the same thing, with the note
			// present in only one. The exact path cannot resolve (the file is not in
			// `Deep-Folder`), so repair runs and finds the segment matches both.
			// Guessing would silently serve a note from a directory the caller did
			// not name, so it refuses.
			put(dir, "reference/Deep Folder/A Long Note.md", NOTE("the real one"));
			put(dir, "reference/Deep-Folder/Something Else.md", NOTE("a decoy"));
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["reference"] });

			assert.equal(
				resolveResourceUri(dir, policy, "vault://note/reference/Deep-Folder/A-Long-Note.md", "myvault"),
				null,
				"ambiguous directory segment must not be guessed",
			);
			// Unambiguous still works, so the guard has not disabled repair.
			assert.ok(
				resolveResourceUri(dir, policy, "vault://note/reference/Deep Folder/A-Long-Note.md", "myvault"),
			);
		});
	});

	test("de-slugging loosens nothing: an out-of-scope note stays out of scope", () => {
		withVault((dir) => {
			stocked(dir);
			put(dir, "work/1-1/Sarah Jones.md", NOTE("a 1:1 note"));
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			for (const uri of [
				"vault://note/work/1-1/Sarah-Jones.md",
				"vault://note/myvault/work/1-1/Sarah-Jones.md",
				"vault://note/myvault/brain/../work/1-1/Sarah-Jones.md",
			]) {
				assert.equal(resolveResourceUri(dir, policy, uri, "myvault"), null, uri);
			}
			// A never-expose note is still refused when reached by its slug.
			assert.equal(resolveResourceUri(dir, policy, "vault://note/brain/Private-Thing.md", "myvault"), null);
		});
	});

	test("the prefix retry loosens nothing: policy still decides after stripping", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });

			// Out of scope stays out of scope, prefixed or not.
			assert.equal(
				resolveResourceUri(dir, policy, "vault://note/myvault/work/1-1/Sarah.md", "myvault"),
				null,
			);
			// Traversal is still refused when it arrives behind the prefix.
			assert.equal(
				resolveResourceUri(dir, policy, "vault://note/myvault/brain/../work/1-1/Sarah.md", "myvault"),
				null,
			);
			// Only the exact collection name is stripped, and only once.
			assert.equal(resolveResourceUri(dir, policy, "vault://note/other/brain/Gotchas.md", "myvault"), null);
			assert.equal(
				resolveResourceUri(dir, policy, "vault://note/myvault/myvault/brain/Gotchas.md", "myvault"),
				null,
			);
		});
	});

	test("traversal is refused, encoded or not", () => {
		withVault((dir) => {
			stocked(dir);
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			for (const bad of [
				"vault://note/../../../etc/passwd",
				"vault://note/brain/../../work/1-1/Sarah.md",
				"vault://note/%2e%2e/%2e%2e/work/1-1/Sarah.md",
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

	test("containment is against the DECLARED ROOT, not the first path segment", () => {
		// A vault serving `work/active/` and not `work/1-1/`. Both share the segment
		// `work`, so containing against the segment accepts a link that escapes the
		// root the caller actually reached the note through.
		withVault((dir) => {
			const target = put(dir, "work/1-1/Sarah.md", NOTE("not served"));
			mkdirSync(join(dir, "work", "active"), { recursive: true });
			const link = join(dir, "work", "active", "innocent.md");
			try {
				symlinkSync(target, link, "file");
			} catch {
				return;
			}
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["work/active"] });
			assert.equal(
				resolveResourceUri(dir, policy, "vault://note/work/active/innocent.md"),
				null,
				"still inside work/, but outside work/active/ — must be refused",
			);
		});
	});
});

// ---------------------------------------------------------------------------
// Symlinks during ENUMERATION, not only on read-back
// ---------------------------------------------------------------------------

describe("enumeration follows the same containment rule as read-back", () => {
	/** Build a vault with `brain/innocent.md` linking wherever `target` points. */
	function linked(dir: string, target: string): boolean {
		stocked(dir);
		try {
			symlinkSync(target, join(dir, "brain", "innocent.md"), "file");
			return true;
		} catch {
			return false; // Windows without developer mode
		}
	}

	test("a .md symlink escaping the vault is not enumerated by ANY surface", () => {
		// The gap this closes: `statSync` follows links, so the walk pulled in a
		// file from anywhere on disk. `resolveResourceUri` refused that same path,
		// which is precisely the two-read-paths-disagree failure — and the leak was
		// real, since `listResources` publishes each note's description.
		withVault((dir) => {
			const outside = put(dir, "..-outside/secret.md", NOTE("OUT-OF-VAULT-MARKER"));
			if (!linked(dir, outside)) return;
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });

			const files = visibleFiles(dir, policy);
			assert.ok(!files.some((f) => f.label === "innocent"), "not enumerated");

			const resources = listResources(dir, policy);
			assert.ok(
				!resources.some((r) => r.description.includes("OUT-OF-VAULT-MARKER")),
				"the outside file's description must not reach the resource listing",
			);

			assert.ok(
				![...allowedSearchPaths(dir, policy)].some((p) => p.includes("innocent")),
				"and search must not accept a hit on it",
			);
		});
	});

	test("a symlink that stays INSIDE the exposed root is still served", () => {
		// The fix must not cost ordinary use: a link within the root is a legitimate
		// way to file the same note twice, and refusing it would be over-correction.
		withVault((dir) => {
			const inside = join(dir, "brain", "Gotchas.md");
			if (!linked(dir, inside)) return;
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			assert.ok(
				visibleFiles(dir, policy).some((f) => f.label === "innocent"),
				"a contained link is a normal note",
			);
		});
	});

	test("a symlinked DIRECTORY escaping the root is not walked into", () => {
		// The same hole one level up: the walk recurses through directories, so a
		// linked folder would hand back every note underneath it.
		withVault((dir) => {
			stocked(dir);
			put(dir, "..-elsewhere/Buried.md", NOTE("DIR-ESCAPE-MARKER"));
			try {
				symlinkSync(join(dir, "..-elsewhere"), join(dir, "brain", "sub"), "junction");
			} catch {
				return;
			}
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			const files = visibleFiles(dir, policy);
			assert.ok(!files.some((f) => f.label === "Buried"), "the linked tree must not be walked");
			assert.ok(
				!listResources(dir, policy).some((r) => r.description.includes("DIR-ESCAPE-MARKER")),
				"and nothing under it may reach the listing",
			);
		});
	});

	test("a broken symlink is skipped rather than throwing the whole walk away", () => {
		withVault((dir) => {
			if (!linked(dir, join(dir, "brain", "Nothing Here.md"))) return;
			const policy = resolveExposure(dir, { mcp_exposed_roots: ["brain"] });
			const files = visibleFiles(dir, policy);
			assert.ok(!files.some((f) => f.label === "innocent"), "a dangling link is not a note");
			assert.ok(files.some((f) => f.label === "Gotchas"), "and the real notes still enumerate");
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
