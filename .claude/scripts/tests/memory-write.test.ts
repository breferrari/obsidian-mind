/**
 * Hardening suite for the vault memory layer.
 *
 * Ordered from real situations outward to the adversarial ones, because the
 * cheap tests are the ones that fail first when something breaks. The last
 * section is a containment property test: the path builder is handed hostile
 * titles and must never produce a path that escapes the memory root.
 *
 * Zero dependencies, matching the harness.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, resolve } from "node:path";

import {
	slugify,
	isoDate,
	memoryPath,
	narrowScope,
	resolveLinks,
	validateMemory,
	renderMemory,
	deriveDescription,
	writeMemory,
	readMemory,
	MEMORY_ROOT,
	type MemoryInput,
} from "../lib/memory-write.ts";

const DAY = new Date(2026, 6, 26, 14, 2, 11); // 2026-07-26, local
const OK = {
	title: "tsup externals decide what a patch can fix",
	body:
		"patch-package only patches this repo's node_modules. A dependency marked external in tsup is resolved on the user's machine at install time, so the patch never reaches them.",
	confidence: "inferred",
};

function tmpVault(): string {
	return mkdtempSync(join(tmpdir(), "memtest-"));
}

/** Split frontmatter off a rendered memory and return the raw lines. */
function frontmatter(md: string): string[] {
	const m = md.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(m, "rendered memory must open with a frontmatter block");
	return (m[1] ?? "").split("\n");
}

function fmValue(md: string, key: string): string | undefined {
	const line = frontmatter(md).find((l: string) => l.startsWith(`${key}:`));
	return line === undefined ? undefined : line.slice(key.length + 1).trim();
}

/** fmValue where the caller has already established the key must be present. */
function fmRequired(md: string, key: string): string {
	const v = fmValue(md, key);
	assert.ok(v !== undefined, `frontmatter key "${key}" is missing`);
	return v;
}

// ---------------------------------------------------------------------------
// 1. The real path
// ---------------------------------------------------------------------------

describe("real usage", () => {
	test("a normal memory validates, renders and writes where the blueprint says", () => {
		const v = validateMemory(OK, { now: DAY, origin: "pocket" });
		assert.equal(v.ok, true, JSON.stringify(v.errors));

		const dir = tmpVault();
		try {
			const { rel } = writeMemory(dir, v.value!, ["pocket"]);
			assert.equal(rel, "memories/2026/07/2026-07-26 tsup externals decide what a patch can fix.md");
			assert.ok(existsSync(join(dir, rel)));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("frontmatter carries every field the architecture doc promises", () => {
		const v = validateMemory(
			{ ...OK, scope: "project", projects: ["pocket", "obsidian-mind"], platforms: ["ios"] },
			{ now: DAY, origin: "pocket" },
		);
		const md = renderMemory(v.value!, ["pocket"]);
		assert.equal(fmValue(md, "date"), "2026-07-26");
		assert.equal(fmValue(md, "source"), "mcp-capture");
		assert.equal(fmValue(md, "origin"), '"pocket"');
		assert.equal(fmValue(md, "scope"), "project");
		assert.equal(fmValue(md, "projects"), '["pocket", "obsidian-mind"]');
		assert.equal(fmValue(md, "platforms"), '["ios"]');
		assert.equal(fmValue(md, "confidence"), "inferred");
		assert.equal(fmValue(md, "tags"), "[memory]");
		assert.ok(fmRequired(md, "session").includes("T"));
	});

	test("projects is a list, which is the whole point", () => {
		const v = validateMemory({ ...OK, projects: ["a", "b", "c"] }, { now: DAY, origin: "a" });
		assert.deepEqual(v.value!.projects, ["a", "b", "c"]);
	});

	test("body and title survive into the note verbatim", () => {
		const v = validateMemory(OK, { now: DAY, origin: "pocket" });
		const md = renderMemory(v.value!, []);
		assert.ok(md.includes(`# ${OK.title}`));
		assert.ok(md.includes(OK.body));
	});

	test("verification renders its own section", () => {
		const v = validateMemory({ ...OK, verification: "Ran npm pack; patches/ absent." }, { now: DAY, origin: "p" });
		const md = renderMemory(v.value!, []);
		assert.ok(md.includes("## How this is known"));
		assert.ok(md.includes("Ran npm pack"));
	});
});

// ---------------------------------------------------------------------------
// 2. Scope narrowing — never widens
// ---------------------------------------------------------------------------

describe("scope narrowing", () => {
	test("general + named projects downgrades to project", () => {
		const r = narrowScope({ scope: "general", projects: ["pocket"], origin: "pocket" });
		assert.equal(r.scope, "project");
		assert.equal(r.downgraded_from, "general");
	});

	test("general naming nothing STANDS, with or without an origin", () => {
		// Regression. An earlier version attributed this case to the origin repo,
		// so every general memory silently became project-scoped to whoever wrote
		// it and the general tier was UNREACHABLE through the server — while the
		// reader, the tool schema, the Base view and the docs all still described
		// it. Found by an adversarial run in which five of six callers could not
		// see a memory explicitly written as general.
		for (const origin of ["pocket", null]) {
			const r = narrowScope({ scope: "general", projects: [], origin });
			assert.equal(r.scope, "general", `origin=${origin}`);
			assert.deepEqual(r.projects, []);
			assert.equal(r.downgraded_from, null);
		}
	});

	test("a downgrade is recorded in the note, not hidden", () => {
		// The surviving downgrade: general WITH named projects is scoped to them
		// by the caller's own admission.
		const v = validateMemory({ ...OK, scope: "general", projects: ["pocket"] }, { now: DAY, origin: "pocket" });
		const md = renderMemory(v.value!, []);
		assert.equal(fmValue(md, "claimed_scope"), "general");
	});

	test("scope is never widened", () => {
		for (const origin of ["pocket", null]) {
			for (const projects of [[], ["a"], ["a", "b"]]) {
				const r = narrowScope({ scope: "project", projects, origin });
				assert.notEqual(r.scope, "general", "project must never become general");
			}
		}
	});

	test("platform scope passes through untouched", () => {
		const r = narrowScope({ scope: "platform", projects: [], origin: "pocket" });
		assert.equal(r.scope, "platform");
	});
});

// ---------------------------------------------------------------------------
// 3. Link resolution — never emit a broken edge
// ---------------------------------------------------------------------------

describe("link resolution", () => {
	const known = new Set(["pocket", "obsidian-mind"]);

	test("resolvable links survive, unresolvable are dropped and reported", () => {
		const r = resolveLinks(["pocket", "Ghost Note"], known);
		assert.deepEqual(r.resolved, ["pocket"]);
		assert.deepEqual(r.dropped, ["Ghost Note"]);
	});

	test("matching is case-insensitive but preserves the caller's casing", () => {
		const r = resolveLinks(["POCKET"], known);
		assert.deepEqual(r.resolved, ["POCKET"]);
	});

	test("duplicates collapse", () => {
		const r = resolveLinks(["pocket", "Pocket", "pocket"], known);
		assert.equal(r.resolved.length, 1);
	});

	test("empty and non-array input is survivable", () => {
		assert.deepEqual(resolveLinks(undefined, known).resolved, []);
		assert.deepEqual(resolveLinks(null, known).dropped, []);
		assert.deepEqual(resolveLinks(["", "   "], known).resolved, []);
	});

	test("no resolvable links means no Related section rather than an empty one", () => {
		const v = validateMemory(OK, { now: DAY, origin: "p" });
		assert.ok(!renderMemory(v.value!, []).includes("## Related"));
	});
});

// ---------------------------------------------------------------------------
// 4. The epistemic contract
// ---------------------------------------------------------------------------

describe("epistemic contract", () => {
	const ctx = { now: DAY, origin: "pocket" };

	test("recurrence claims are flagged and capped, not rejected", () => {
		// v1 REJECTED these. That was wrong: a false reject destroys knowledge the
		// session already had, while a false flag costs one frontmatter line.
		for (const claim of [
			"This always breaks on Windows when the path has a space in it somewhere.",
			"The installer never recovers from a partial write, so state is lost.",
			"Every time the cache is cold the build fails with a null exit code.",
			"This keeps happening whenever two vaults share one index name.",
		]) {
			const r = validateMemory({ ...OK, body: claim, confidence: "verified" }, ctx);
			assert.equal(r.ok, true, `should accept but flag: ${claim}`);
			assert.ok(r.value!.flags.includes("generalised"), `no flag for: ${claim}`);
			assert.equal(r.value!.confidence, "inferred", "a generalised claim cannot stay verified");
			assert.equal(r.value!.claimed_confidence, "verified", "the original claim stays auditable");
		}
	});

	test("a deterministic consequence using the word 'never' is NOT flagged", () => {
		// The regression that killed v1: "the patch never reaches them" describes a
		// mechanism, not a frequency. This is the canonical example from the docs.
		const r = validateMemory(OK, ctx);
		assert.equal(r.ok, true, JSON.stringify(r.errors));
		assert.deepEqual(r.value!.flags, [], "benign prose must not be flagged");
	});

	test("a single dated occurrence is accepted", () => {
		const r = validateMemory(
			{
				...OK,
				body: "On 2026-07-26 the build failed with a null exit code because the guard had no timeout.",
			},
			ctx,
		);
		assert.equal(r.ok, true, JSON.stringify(r.errors));
	});

	test("volatile figures without a date anchor are flagged, not rejected", () => {
		const r = validateMemory(
			{
				...OK,
				body: "The template repo has 3974 stars and 480 forks right now, which is worth recording.",
				confidence: "verified",
			},
			ctx,
		);
		assert.equal(r.ok, true);
		assert.ok(r.value!.flags.includes("volatile"));
		assert.equal(r.value!.confidence, "inferred", "an undated figure cannot be verified");
	});

	test("the same figure with an anchor is accepted", () => {
		const r = validateMemory(
			{ ...OK, body: "The template repo has 3974 stars as of 2026-07-26, which is up from launch." },
			ctx,
		);
		assert.equal(r.ok, true, JSON.stringify(r.errors));
		assert.deepEqual(r.value!.flags, [], "an anchored figure carries no volatile flag");
	});

	test("transcripts are rejected, short dialogue quotes are not", () => {
		const transcript = ["User: why did it fail", "Assistant: because of X", "User: fix it", "Assistant: done"].join("\n");
		assert.equal(validateMemory({ ...OK, body: transcript }, ctx).ok, false);

		const quoted = "The maintainer said:\nUser: it fails on Windows\nThat was the only report we had, so it stays unverified for now.";
		assert.equal(validateMemory({ ...OK, body: quoted }, ctx).ok, true);
	});

	test("verified without verification warns but does not block", () => {
		const r = validateMemory({ ...OK, confidence: "verified" }, ctx);
		assert.equal(r.ok, true);
		assert.ok(r.warnings.some((w) => /verified/i.test(w)));
	});

	test("general without generality warns but does not block", () => {
		const r = validateMemory({ ...OK, scope: "general" }, ctx);
		assert.equal(r.ok, true);
		assert.ok(r.warnings.some((w) => /generality/i.test(w)));
	});

	test("a supplied generality silences the warning and is carried onto the value", () => {
		const r = validateMemory({ ...OK, scope: "general", generality: "true of any language with a module system" }, ctx);
		assert.equal(r.ok, true);
		assert.ok(!r.warnings.some((w) => /generality/i.test(w)));
		assert.match(String(r.value?.generality), /module system/);
	});

	// The warning keys on the NARROWED scope. A caller who claims `general` and
	// names projects has been downgraded to `project` by their own admission, so
	// asking them to justify a reach they did not end up claiming is noise.
	test("general downgraded to project by named projects does not warn about generality", () => {
		const r = validateMemory({ ...OK, scope: "general", projects: ["alpha"] }, ctx);
		assert.equal(r.ok, true);
		assert.equal(r.value?.scope, "project");
		assert.ok(!r.warnings.some((w) => /generality/i.test(w)));
	});

	test("an oversized body warns about atomicity rather than failing", () => {
		const r = validateMemory({ ...OK, body: "x. ".repeat(5000) }, ctx);
		assert.equal(r.ok, true);
		assert.ok(r.warnings.some((w) => /atomic/i.test(w)));
	});
});

// ---------------------------------------------------------------------------
// 5. Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
	const ctx = { now: DAY, origin: "pocket" };

	test("missing required fields are all reported at once, not one at a time", () => {
		const r = validateMemory({}, ctx);
		assert.equal(r.ok, false);
		assert.ok(r.errors.length >= 3, "should report title, body and confidence together");
	});

	test("a too-short body is rejected with its actual length", () => {
		const r = validateMemory({ ...OK, body: "it broke" }, ctx);
		assert.equal(r.ok, false);
		assert.ok(r.errors.some((e) => /\d+ chars/.test(e)));
	});

	test("bad confidence and scope enums are rejected", () => {
		assert.equal(validateMemory({ ...OK, confidence: "pretty sure" }, ctx).ok, false);
		assert.equal(validateMemory({ ...OK, scope: "universe" }, ctx).ok, false);
	});

	test("projects must be an array, not a string", () => {
		const r = validateMemory({ ...OK, projects: "pocket" }, ctx);
		assert.equal(r.ok, false);
		assert.ok(r.errors.some((e) => /multi-valued/i.test(e)));
	});

	test("project slugs with separators or spaces are rejected", () => {
		for (const bad of ["../etc", "a/b", "has space", "semi;colon", ""]) {
			assert.equal(validateMemory({ ...OK, projects: [bad] }, ctx).ok, false, `should reject ${JSON.stringify(bad)}`);
		}
	});

	test("non-string project entries are rejected rather than coerced", () => {
		assert.equal(validateMemory({ ...OK, projects: [42] }, ctx).ok, false);
		assert.equal(validateMemory({ ...OK, projects: [null] }, ctx).ok, false);
		assert.equal(validateMemory({ ...OK, projects: [{}] }, ctx).ok, false);
	});

	test("null and undefined input do not throw", () => {
		assert.equal(validateMemory(null, ctx).ok, false);
		assert.equal(validateMemory(undefined, ctx).ok, false);
	});
});

// ---------------------------------------------------------------------------
// 6. Slug and path — the hostile section
// ---------------------------------------------------------------------------

describe("slug and path safety", () => {
	test("path separators cannot survive a title", () => {
		assert.ok(!slugify("a/b\\c").includes("/"));
		assert.ok(!slugify("a/b\\c").includes("\\"));
	});

	test("traversal is neutralised", () => {
		const s = slugify("../../etc/passwd");
		assert.ok(!s.includes(".."));
		assert.ok(!s.includes("/"));
	});

	test("windows reserved stems are escaped", () => {
		for (const name of ["CON", "con", "PRN", "AUX", "NUL", "COM1", "LPT9"]) {
			assert.ok(slugify(name).startsWith("_"), `${name} must not be a bare reserved name`);
		}
	});

	test("trailing dots and spaces are folded (NTFS strips them silently)", () => {
		assert.ok(!/[. ]$/.test(slugify("trailing dots...")));
		assert.ok(!/[. ]$/.test(slugify("trailing space   ")));
	});

	test("long titles are truncated on a word boundary", () => {
		const s = slugify("the quick brown fox jumps over the lazy dog and keeps running for a very long time indeed");
		assert.ok(s.length <= 60);
		assert.ok(!s.endsWith(" "));
	});

	test("unicode titles survive as filenames", () => {
		assert.ok(slugify("日本語のメモ").length > 0);
		assert.ok(slugify("café déjà vu").length > 0);
	});

	test("a title that slugifies to nothing is rejected, not written as a dotfile", () => {
		for (const bad of ["...", "///", "   ", "***"]) {
			const r = validateMemory({ ...OK, title: bad }, { now: DAY, origin: "p" });
			assert.equal(r.ok, false, `should reject title ${JSON.stringify(bad)}`);
		}
	});

	test("newlines in a title cannot break the path or the H1", () => {
		const s = slugify("line one\nline two");
		assert.ok(!s.includes("\n"));
	});

	test("the month folder is zero-padded and the year splits correctly", () => {
		assert.equal(memoryPath(new Date(2026, 0, 5), "x"), "memories/2026/01/2026-01-05 x.md");
		assert.equal(memoryPath(new Date(2026, 11, 31), "x"), "memories/2026/12/2026-12-31 x.md");
	});

	test("a custom memory root is honoured (config, not hardcoded)", () => {
		assert.ok(memoryPath(DAY, "x", "recall").startsWith("recall/2026/07/"));
	});
});

// ---------------------------------------------------------------------------
// 7. YAML safety — frontmatter that fails to parse is invisible
// ---------------------------------------------------------------------------

describe("frontmatter safety", () => {
	test("quotes and colons in the body cannot break the description", () => {
		const body =
			'He said: "it fails", and the config had key: value pairs inline — which is exactly the shape that breaks naive YAML.';
		const v = validateMemory({ ...OK, body }, { now: DAY, origin: "p" });
		const desc = fmRequired(renderMemory(v.value!, []), "description");
		assert.doesNotThrow(() => JSON.parse(desc), "description must be a valid double-quoted scalar");
	});

	test("a newline in the body never reaches the description as a literal", () => {
		const v = validateMemory({ ...OK, body: "first line\nsecond line, long enough to pass the minimum length check." }, { now: DAY, origin: "p" });
		const desc = fmRequired(renderMemory(v.value!, []), "description");
		assert.ok(!desc.includes("\n"));
		assert.doesNotThrow(() => JSON.parse(desc));
	});

	test("an origin with a quote cannot escape its scalar", () => {
		const v = validateMemory(OK, { now: DAY, origin: 'we"ird' });
		const md = renderMemory(v.value!, []);
		assert.doesNotThrow(() => JSON.parse(fmRequired(md, "origin")));
	});

	test("description stays within the vault's ~150 char convention", () => {
		const v = validateMemory({ ...OK, body: "word ".repeat(200) }, { now: DAY, origin: "p" });
		assert.ok(deriveDescription(v.value!.body).length <= 152);
	});

	test("frontmatter opens and closes exactly once", () => {
		const v = validateMemory(OK, { now: DAY, origin: "p" });
		const md = renderMemory(v.value!, []);
		assert.equal((md.match(/^---$/gm) || []).length, 2);
	});
});

// ---------------------------------------------------------------------------
// 8. Write collisions — never clobber
// ---------------------------------------------------------------------------

describe("write collisions", () => {
	test("two memories with the same title on the same day do not overwrite", () => {
		const dir = tmpVault();
		try {
			const v = validateMemory(OK, { now: DAY, origin: "p" }).value!;
			const a = writeMemory(dir, v, []);
			const b = writeMemory(dir, { ...v, body: "different body, same title, same day, still needs saving." }, []);
			assert.notEqual(a.rel, b.rel);
			assert.ok(b.rel.includes("(2)"));
			assert.ok(readMemory(dir, a.rel).includes(OK.body), "the first memory must survive intact");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the collision suffix keeps the .md extension", () => {
		const dir = tmpVault();
		try {
			const v = validateMemory(OK, { now: DAY, origin: "p" }).value!;
			writeMemory(dir, v, []);
			assert.ok(writeMemory(dir, v, []).rel.endsWith(".md"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing month folders are created", () => {
		const dir = tmpVault();
		try {
			const v = validateMemory(OK, { now: new Date(2027, 2, 3), origin: "p" }).value!;
			assert.ok(existsSync(writeMemory(dir, v, []).full));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 9. Containment property — the fuzz pass
// ---------------------------------------------------------------------------

describe("containment property", () => {
	/**
	 * The one invariant that must hold for EVERY input: whatever a caller puts
	 * in a title, the resolved write path stays inside the memory root. A single
	 * escape here is an arbitrary-file-write through a tool description.
	 */
	test("no title can produce a path outside the memory root", () => {
		const hostile = [
			"../../../etc/passwd",
			"..\\..\\windows\\system32\\config",
			"/etc/shadow",
			"C:\\Windows\\System32",
			"....//....//escape",
			"a\u0000b",
			"\u202Egnp.exe",
			"CON",
			"....",
			"~/.ssh/authorized_keys",
			"%2e%2e%2f",
			"a".repeat(500),
			"🙂".repeat(80),
			"\n\n../x",
			"..",
			".",
		];
		const root = resolve("/vault");
		for (const title of hostile) {
			const slug = slugify(title);
			if (!slug) continue; // rejected upstream by validateMemory
			const rel = memoryPath(DAY, title);
			const full = resolve(root, rel);
			assert.ok(
				full.startsWith(resolve(root, MEMORY_ROOT) + sep),
				`escaped containment: ${JSON.stringify(title)} -> ${full}`,
			);
			assert.ok(!rel.includes(".."), `traversal survived: ${JSON.stringify(title)}`);
		}
	});

	test("random titles always yield a containable, single-segment filename", () => {
		const alphabet = "abc /\\.:*?\"<>|\u0000\n\t~%-_日🙂";
		let checked = 0;
		for (let i = 0; i < 400; i++) {
			let title = "";
			const len = 1 + ((i * 7) % 40);
			for (let j = 0; j < len; j++) title += alphabet[(i * 13 + j * 31) % alphabet.length];
			const slug = slugify(title);
			if (!slug) continue;
			assert.ok(!slug.includes("/"), `slug kept a separator: ${JSON.stringify(slug)}`);
			assert.ok(!slug.includes("\\"), `slug kept a backslash: ${JSON.stringify(slug)}`);
			assert.ok(!slug.includes(".."), `slug kept a traversal: ${JSON.stringify(slug)}`);
			assert.ok(!/[. ]$/.test(slug), `slug ended in dot/space: ${JSON.stringify(slug)}`);
			checked++;
		}
		assert.ok(checked > 100, `expected many usable slugs, got ${checked}`);
	});

	test("a memory written from a hostile title lands inside the vault", () => {
		const dir = tmpVault();
		try {
			const v = validateMemory({ ...OK, title: "../../escape attempt" }, { now: DAY, origin: "p" });
			assert.equal(v.ok, true, "this title still has usable characters, so it should validate");
			const { full } = writeMemory(dir, v.value!, []);
			assert.ok(resolve(full).startsWith(resolve(dir, MEMORY_ROOT) + sep));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 10. Reachability — never write a memory nobody can ever see
// ---------------------------------------------------------------------------

describe("reachability guard", () => {
	test("a project-scoped memory with no projects and no caller identity is REFUSED", () => {
		// The observed hole: a client that never answered roots/list writes a
		// memory that validates, indexes, reports success — and is invisible to
		// every caller forever.
		const r = validateMemory(OK, { now: DAY, origin: null });
		assert.equal(r.ok, false);
		assert.ok(r.errors.some((e) => /reach nobody/i.test(e)));
		assert.ok(r.errors.some((e) => /general/.test(e)), "the error must name the way out");
	});

	test("the same memory is fine once the caller has an identity", () => {
		assert.equal(validateMemory(OK, { now: DAY, origin: "atlas" }).ok, true);
	});

	test("the same memory is fine once it names its projects", () => {
		assert.equal(validateMemory({ ...OK, projects: ["atlas"] }, { now: DAY, origin: null }).ok, true);
	});

	test("an explicitly general memory needs neither", () => {
		const r = validateMemory({ ...OK, scope: "general" }, { now: DAY, origin: null });
		assert.equal(r.ok, true);
		assert.equal(r.value!.scope, "general");
	});

	test("a platform-scoped memory naming no platforms is REFUSED", () => {
		const r = validateMemory({ ...OK, scope: "platform" }, { now: DAY, origin: "atlas" });
		assert.equal(r.ok, false);
		assert.ok(r.errors.some((e) => /reach nobody/i.test(e)));
	});

	test("a platform-scoped memory naming platforms is fine", () => {
		assert.equal(
			validateMemory({ ...OK, scope: "platform", platforms: ["ios"] }, { now: DAY, origin: "atlas" }).ok,
			true,
		);
	});

	test("refusing beats widening — an unscopable memory never becomes general", () => {
		// Silently granting the WIDEST reach because the narrowest could not be
		// determined is the opposite of what narrowing is for.
		const r = validateMemory(OK, { now: DAY, origin: null });
		assert.equal(r.value!, null, "nothing is written at all");
	});

	test("every memory that validates is visible to at least one caller", () => {
		// The property the guard exists to hold. Any accepted memory must have a
		// facet some caller could match.
		const cases: [MemoryInput, { now: Date; origin: string | null }][] = [
			[{ ...OK, projects: ["atlas"] }, { now: DAY, origin: null }],
			[{ ...OK }, { now: DAY, origin: "atlas" }],
			[{ ...OK, scope: "general" }, { now: DAY, origin: null }],
			[{ ...OK, scope: "platform", platforms: ["ios"] }, { now: DAY, origin: "atlas" }],
		];
		for (const [input, ctx] of cases) {
			const r = validateMemory(input, ctx);
			assert.equal(r.ok, true, JSON.stringify(r.errors));
			const reachable =
				r.value!.scope === "general" || r.value!.projects.length > 0 || r.value!.platforms.length > 0;
			assert.ok(reachable, `accepted an unreachable memory: ${JSON.stringify(r.value!)}`);
		}
	});
});
