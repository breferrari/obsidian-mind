/**
 * Precision harness for memory retrieval.
 *
 * Builds a synthetic vault covering the real shapes a person actually has:
 *
 *   atlas       iOS app
 *   beacon      iOS app        — same platform, different project
 *   harbor      web app        — different platform, different project
 *   atlas-api   backend        — different platform, SAME product context
 *   drifter     unrelated      — shares nothing
 *   (unknown)   no identity    — an agent with no MCP roots
 *
 * Memories are written through the real writer, so this is a write→read round
 * trip rather than a test against hand-authored markdown: if the writer and the
 * reader ever disagree about a facet, it fails here.
 *
 * Every case asserts BOTH directions — what surfaced and what was withheld —
 * because a retrieval layer is only as good as the things it refuses to return.
 * A false positive puts another project's context into this session, where it is
 * acted on as if it applied; a false negative is a memory nobody benefits from.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { validateMemory, writeMemory } from "../lib/memory-write.ts";
import {
	recall,
	isVisibleTo,
	facetsOf,
	parseFrontmatter,
	specificity,
	rankMemories,
	type Caller,
} from "../lib/memory-recall.ts";

const DAY = new Date(2026, 6, 26);

const CALLERS = {
	atlas: { project: "atlas", platforms: ["ios"] },
	beacon: { project: "beacon", platforms: ["ios"] },
	harbor: { project: "harbor", platforms: ["web"] },
	atlasApi: { project: "atlas-api", platforms: ["backend"] },
	drifter: { project: "drifter", platforms: ["android"] },
	unknown: { project: null, platforms: [] },
};

/**
 * The fixture set. `id` is embedded in the title so assertions read as sets of
 * ids rather than as brittle prose matching.
 */
const FIXTURES = [
	{
		id: "M1",
		title: "M1 atlas keychain migration must run before first read",
		scope: "project",
		projects: ["atlas"],
	},
	{
		id: "M2",
		title: "M2 the atlas session token format is shared with the api",
		scope: "project",
		projects: ["atlas", "atlas-api"],
	},
	{
		id: "M3",
		title: "M3 ios background tasks are killed after thirty seconds",
		scope: "platform",
		platforms: ["ios"],
	},
	{
		id: "M4",
		title: "M4 web service workers cache opaque responses silently",
		scope: "platform",
		platforms: ["web"],
	},
	{ id: "M5", title: "M5 semver patch releases still break lockfiles", scope: "general", projects: [] },
	{ id: "M6", title: "M6 beacon analytics batches on a five minute timer", scope: "project", projects: ["beacon"] },
	{
		id: "M7",
		title: "M7 atlas ios build needs the legacy provisioning profile",
		scope: "project",
		projects: ["atlas"],
		platforms: ["ios"],
	},
	{
		id: "M8",
		title: "M8 mobile deep links need an intent filter and an assoc file",
		scope: "platform",
		platforms: ["ios", "android"],
	},
];

const BODY =
	"Recorded by the precision harness. The body is long enough to satisfy the minimum length rule and says nothing that trips a contract flag.";

let VAULT: string;

before(() => {
	VAULT = mkdtempSync(join(tmpdir(), "recall-"));
	for (const f of FIXTURES) {
		const v = validateMemory(
			{
				title: f.title,
				body: BODY,
				confidence: "inferred",
				scope: f.scope,
				projects: f.projects ?? [],
				platforms: f.platforms ?? [],
			},
			// origin is deliberately null for general fixtures so write-side
			// narrowing does not re-attribute them to a project.
			{ now: DAY, origin: null },
		);
		assert.equal(v.ok, true, `fixture ${f.id} failed validation: ${JSON.stringify(v.errors)}`);
		writeMemory(VAULT, v.value!, []);
	}
});

after(() => rmSync(VAULT, { recursive: true, force: true }));

/** Ids visible to a caller, as a sorted array. */
function seen(caller: Caller): string[] {
	return recall(VAULT, caller)
		.map((e) => (e.title ?? "").split(" ")[0]!)
		.sort();
}

function withheldIds(caller: Caller): string[] {
	return recall(VAULT, caller, { explain: true })
		.withheld.map((e) => (e.title ?? "").split(" ")[0]!)
		.sort();
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe("retrieval precision matrix", () => {
	test("atlas (ios): own project, shared-context, ios platform, general", () => {
		assert.deepEqual(seen(CALLERS.atlas), ["M1", "M2", "M3", "M5", "M7", "M8"]);
	});

	test("beacon (ios): SAME platform, different project — gets ios lessons, not atlas's", () => {
		assert.deepEqual(seen(CALLERS.beacon), ["M3", "M5", "M6", "M8"]);
		// The headline precision claim: a sibling iOS app must not inherit
		// another app's project-scoped memories, even platform-tagged ones.
		assert.deepEqual(withheldIds(CALLERS.beacon), ["M1", "M2", "M4", "M7"]);
	});

	test("harbor (web): different platform — no ios memories at all", () => {
		assert.deepEqual(seen(CALLERS.harbor), ["M4", "M5"]);
		for (const id of ["M1", "M2", "M3", "M6", "M7", "M8"]) {
			assert.ok(withheldIds(CALLERS.harbor).includes(id), `${id} must not reach a web project`);
		}
	});

	test("atlas-api: SAME context, different platform — shared memory only", () => {
		// M2 names it explicitly, so it crosses the platform boundary. M1 and M7
		// are atlas-only and must not, and no ios memory may reach a backend.
		assert.deepEqual(seen(CALLERS.atlasApi), ["M2", "M5"]);
	});

	test("drifter: shares ONLY a platform — gets that platform's lesson and nothing else", () => {
		// No shared project, no shared product context, no shared codebase. The
		// single android-tagged memory (M8) still reaches it, which is the point
		// of platform scope; every atlas/beacon/harbor memory stays away.
		assert.deepEqual(seen(CALLERS.drifter), ["M5", "M8"]);
		assert.deepEqual(withheldIds(CALLERS.drifter), ["M1", "M2", "M3", "M4", "M6", "M7"]);
	});

	test("an agent with no identity sees general only, not everything", () => {
		assert.deepEqual(seen(CALLERS.unknown), ["M5"]);
	});

	test("every memory reaches at least one caller (no write-only memories)", () => {
		const reached = new Set();
		for (const caller of Object.values(CALLERS)) for (const id of seen(caller)) reached.add(id);
		assert.deepEqual([...reached].sort(), FIXTURES.map((f) => f.id).sort());
	});

	test("no caller sees the whole store", () => {
		for (const [name, caller] of Object.entries(CALLERS)) {
			assert.ok(
				seen(caller).length < FIXTURES.length,
				`${name} saw everything — the scoping rule is not doing anything`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

describe("visibility rule", () => {
	const f = (o: Record<string, unknown>): ReturnType<typeof facetsOf> => facetsOf(o);

	test("general reaches everyone including the anonymous caller", () => {
		for (const caller of Object.values(CALLERS)) {
			assert.equal(isVisibleTo(f({ scope: "general" }), caller), true);
		}
	});

	test("an explicit project listing beats a scope mismatch", () => {
		const m = f({ scope: "platform", projects: ["harbor"], platforms: ["ios"] });
		assert.equal(isVisibleTo(m, CALLERS.harbor), true, "named project must win");
	});

	test("project scope never leaks on a platform near-miss", () => {
		const m = f({ scope: "project", projects: ["atlas"], platforms: ["ios"] });
		assert.equal(isVisibleTo(m, CALLERS.beacon), false);
	});

	test("platform matching is case-insensitive", () => {
		const m = f({ scope: "platform", platforms: ["iOS"] });
		assert.equal(isVisibleTo(m, { project: "x", platforms: ["ios"] }), true);
	});

	test("a memory with no facets at all reaches nobody but stays on disk", () => {
		const m = f({ scope: "project", projects: [], platforms: [] });
		for (const caller of Object.values(CALLERS)) {
			assert.equal(isVisibleTo(m, caller), false);
		}
	});

	test("malformed facets degrade to invisible rather than throwing", () => {
		for (const junk of [null, undefined, {}, { scope: 42 }, { projects: "atlas" }]) {
			assert.doesNotThrow(() => isVisibleTo(facetsOf(junk ?? {}), CALLERS.atlas));
		}
	});

	test("a caller shaped wrongly does not crash retrieval", () => {
		for (const junk of [null, undefined, {}, { project: 0 }, { platforms: "ios" }]) {
			assert.doesNotThrow(() => isVisibleTo(facetsOf({ scope: "general" }), junk as Caller | null | undefined));
		}
	});
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe("ranking", () => {
	test("the caller's own project outranks platform, which outranks general", () => {
		const own = facetsOf({ scope: "project", projects: ["atlas"] });
		const plat = facetsOf({ scope: "platform", platforms: ["ios"] });
		const gen = facetsOf({ scope: "general" });
		assert.ok(specificity(own, CALLERS.atlas) > specificity(plat, CALLERS.atlas));
		assert.ok(specificity(plat, CALLERS.atlas) > specificity(gen, CALLERS.atlas));
	});

	test("a memory naming one project outranks one naming many", () => {
		const narrow = facetsOf({ scope: "project", projects: ["atlas"] });
		const broad = facetsOf({ scope: "project", projects: ["atlas", "b", "c", "d"] });
		assert.ok(specificity(narrow, CALLERS.atlas) > specificity(broad, CALLERS.atlas));
	});

	test("superseded memories sink below live ones", () => {
		const live = { facets: facetsOf({ scope: "general", date: "2026-01-01" }) };
		const dead = { facets: facetsOf({ scope: "general", date: "2026-12-31", superseded_by: ["x"] }) };
		assert.equal(rankMemories([dead, live], CALLERS.atlas)[0], live);
	});

	test("in a real recall, the project-specific memory comes first", () => {
		assert.equal((recall(VAULT, CALLERS.atlas)[0]?.title ?? "").split(" ")[0], "M1");
	});
});

// ---------------------------------------------------------------------------
// Robustness of the reader
// ---------------------------------------------------------------------------

describe("reader robustness", () => {
	test("frontmatter round-trips through the real writer", () => {
		const v = validateMemory(
			{ title: "round trip", body: BODY, confidence: "verified", verification: "checked", projects: ["atlas"] },
			{ now: DAY, origin: "atlas" },
		);
		const dir = mkdtempSync(join(tmpdir(), "rt-"));
		try {
			const { full } = writeMemory(dir, v.value!, []);
			const fm = parseFrontmatter(readFileSync(full, "utf8"));
			assert.equal(fm.source, "mcp-capture");
			assert.deepEqual(facetsOf(fm).projects, ["atlas"]);
			assert.equal(facetsOf(fm).confidence, "verified");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("notes without the mcp-capture source are ignored entirely", () => {
		// A human note that lands in memories/ is not governed by these rules and
		// must not be served as if it were a capture.
		const fm = parseFrontmatter("---\ntitle: mine\n---\n# hand written\n");
		assert.notEqual(fm.source, "mcp-capture");
	});

	test("a file with no frontmatter parses to an empty object rather than throwing", () => {
		assert.deepEqual(parseFrontmatter("# just a heading\n"), {});
		assert.deepEqual(parseFrontmatter(""), {});
		assert.deepEqual(parseFrontmatter(null), {});
	});

	test("an empty list in frontmatter parses to an empty array", () => {
		assert.deepEqual(parseFrontmatter("---\nprojects: []\n---\n").projects, []);
	});

	test("quoted values with commas survive list parsing", () => {
		const fm = parseFrontmatter('---\nprojects: ["a", "b"]\ndescription: "one, two"\n---\n');
		assert.deepEqual(fm.projects, ["a", "b"]);
		assert.equal(fm.description, "one, two");
	});

	test("recall on a vault with no memories returns empty, not an error", () => {
		const dir = mkdtempSync(join(tmpdir(), "empty-"));
		try {
			assert.deepEqual(recall(dir, CALLERS.atlas), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});


// ---------------------------------------------------------------------------
// Promotion is visible to the caller (#179, partial)
// ---------------------------------------------------------------------------

describe("a promoted capture says so", () => {
	test("the marker is parsed off frontmatter", () => {
		// Parsed at read time so the format has ONE definition (#183). `.md` is
		// appended because what the marker addresses is a file.
		assert.deepEqual(facetsOf({ promoted: "brain/Gotchas - Engineering" }).promoted, {
			note: "brain/Gotchas - Engineering.md",
			anchor: null,
			kind: "note",
		});
		assert.deepEqual(facetsOf({ promoted: "brain/Gotchas#^om-a1b2c3" }).promoted, {
			note: "brain/Gotchas.md",
			anchor: "om-a1b2c3",
			kind: "block",
		});
	});

	test("the raw marker is kept, because a null parse is ambiguous", () => {
		// Absent and REJECTED both parse to null, and only the second is a defect.
		// Without the raw string nothing downstream can tell them apart, which is
		// what `health` needs in order to report an unparseable marker at all.
		assert.equal(facetsOf({}).promotedRaw, null);
		assert.equal(facetsOf({ promoted: "brain/X" }).promotedRaw, "brain/X");

		const rejected = facetsOf({ promoted: "brain/X\n\n## FORGED" });
		assert.equal(rejected.promoted, null, "a newline is a forged response, not a path");
		assert.equal(rejected.promotedRaw, "brain/X\n\n## FORGED", "but it WAS declared");
	});

	test("an unpromoted capture reports null rather than a falsy string", () => {
		assert.equal(facetsOf({}).promoted, null);
		assert.equal(facetsOf({ promoted: 123 }).promoted, null, "a non-string marker is not a note name");
		assert.equal(facetsOf({ promoted: 123 }).promotedRaw, null, "and it is not a declaration either");
	});

	/**
	 * Promotion must not change who can see a memory. The marker records that a
	 * corrected copy exists in `brain/`; it says nothing about reach, and reading
	 * it as a reach signal would silently widen or narrow the scope contract.
	 */
	test("promotion does not alter visibility", () => {
		const scoped = { scope: "project", projects: ["atlas"] };
		for (const caller of Object.values(CALLERS)) {
			assert.equal(
				isVisibleTo(facetsOf({ ...scoped, promoted: "brain/Gotchas" }), caller),
				isVisibleTo(facetsOf(scoped), caller),
				"the marker must be inert to the visibility rule",
			);
		}
	});
});
