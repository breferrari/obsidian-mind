/**
 * The correction sweep's judgement, pinned.
 *
 * The search half of a sweep is cheap and its failures are visible: a missed
 * note keeps saying something stale until someone reads it. The classification
 * half is neither. Rewriting a note that correctly recorded what was believed at
 * the time destroys a true record, leaves the note reading perfectly fine, and
 * cannot be detected afterwards by anything.
 *
 * So these tests are weighted towards what must NOT be touched.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	isHistoricalNote,
	classifyCandidate,
	planSweep,
	type SweepCandidate,
} from "../lib/correction-sweep.ts";

const note = (rel: string, frontmatter: Record<string, unknown> = {}): SweepCandidate => ({
	rel,
	frontmatter,
});

describe("isHistoricalNote", () => {
	test("an archived note is historical whatever it is named", () => {
		assert.equal(isHistoricalNote("work/archive/2026/Search Rollout.md"), true);
	});

	test("a dated 1:1 is historical", () => {
		// Carried by the DIRECTORY rule, not the date — `1-1` is a record folder.
		// The date rule is isolated separately below, because a test that passes
		// for a reason it does not name pins nothing.
		assert.equal(isHistoricalNote("work/1-1/Dana Ruiz 2026-03-02.md"), true);
	});

	test("a dated capture is historical", () => {
		assert.equal(isHistoricalNote("work/meetings/2026-03-02 Platform Sync.md"), true);
	});

	// The naming-convention signal ON ITS OWN: no record directory in the path,
	// no status in the frontmatter, nothing but the date to go on.
	test("a date in the filename is enough by itself, prefix or suffix", () => {
		// The suffix case is the one that matters. This vault's 1:1 convention is
		// `<Person> YYYY-MM-DD.md`, so a rule anchored at the start of the name
		// looks correct, passes the directory-backed tests, and silently misses
		// every dated note living outside a record folder.
		assert.equal(isHistoricalNote("org/Reorg Notes 2026-03-02.md"), true);
		assert.equal(isHistoricalNote("work/2026-03-02 Platform Sync.md"), true);
	});

	test("a superseded decision record is historical on frontmatter alone", () => {
		assert.equal(isHistoricalNote("work/Search Rollout.md", { status: "superseded" }), true);
	});

	test("a completed work note is historical — it describes what was done", () => {
		assert.equal(isHistoricalNote("work/Search Rollout.md", { status: "completed" }), true);
	});

	test("a living work note is NOT historical", () => {
		assert.equal(isHistoricalNote("work/Search Quality.md", { status: "active" }), false);
	});

	test("a brain note is NOT historical — it is where corrections land", () => {
		assert.equal(isHistoricalNote("brain/Gotchas.md"), false);
		assert.equal(isHistoricalNote("reference/QMD.md"), false);
	});

	// `date:` is on every note in the vault. Reading it as evidence would
	// classify everything as historical and make the sweep an expensive no-op.
	test("a frontmatter date alone does not make a note historical", () => {
		assert.equal(isHistoricalNote("work/Search Quality.md", { date: "2026-03-02" }), false);
	});

	// Segment match, not substring: otherwise a living policy note about
	// archiving is exempted by its own title.
	test("a living note whose name merely contains a keyword is not exempted", () => {
		assert.equal(isHistoricalNote("work/archive-policy.md"), false);
		assert.equal(isHistoricalNote("reference/meetings-etiquette.md"), false);
	});

	test("status matching is case and whitespace tolerant", () => {
		assert.equal(isHistoricalNote("work/x.md", { status: "  Superseded " }), true);
	});

	test("a malformed status is not a licence to edit", () => {
		assert.equal(isHistoricalNote("work/x.md", { status: 42 }), false);
		assert.equal(isHistoricalNote("work/x.md", {}), false);
	});

	test("windows separators classify the same as posix", () => {
		assert.equal(isHistoricalNote("work\\archive\\2026\\Thing.md"), true);
	});
});

describe("classifyCandidate", () => {
	const AUTH = "reference/QMD.md";

	test("the designated single source is AUTHORITATIVE", () => {
		assert.equal(classifyCandidate(note(AUTH), AUTH), "AUTHORITATIVE");
	});

	test("a living note asserting the fact is a RESTATEMENT", () => {
		assert.equal(classifyCandidate(note("brain/Gotchas.md"), AUTH), "RESTATEMENT");
	});

	test("an archived note is HISTORICAL even while the sweep runs", () => {
		assert.equal(classifyCandidate(note("work/archive/2026/Intake.md"), AUTH), "HISTORICAL");
	});

	// If the single-source note has itself been retired, the correction belongs
	// in whatever replaced it. Rewriting the retired one is the exact damage
	// this module exists to prevent, so HISTORICAL wins.
	test("HISTORICAL beats AUTHORITATIVE when the source note is itself retired", () => {
		const retired = note(AUTH, { status: "superseded" });
		assert.equal(classifyCandidate(retired, AUTH), "HISTORICAL");
	});
});

describe("planSweep", () => {
	const AUTH = "reference/QMD.md";
	const candidates = [
		note(AUTH),
		note("brain/Gotchas.md"),
		note("work/Search Quality.md", { status: "active" }),
		note("work/archive/2026/Intake.md"),
		note("work/1-1/Dana Ruiz 2026-03-02.md"),
	];

	test("exactly one note is edited and every record is preserved", () => {
		const plan = planSweep(candidates, AUTH);
		assert.equal(plan.apply?.rel, AUTH);
		assert.deepEqual(
			plan.replaceWithLink.map((c) => c.rel),
			["brain/Gotchas.md", "work/Search Quality.md"],
		);
		assert.deepEqual(plan.preserve.map((c) => c.rel), [
			"work/archive/2026/Intake.md",
			"work/1-1/Dana Ruiz 2026-03-02.md",
		]);
		assert.deepEqual(plan.blocked, []);
	});

	// Replacing restatements with links to a source nobody corrected propagates
	// the stale claim behind a link rather than removing it.
	test("with no authoritative note designated, NOTHING is edited", () => {
		const plan = planSweep(candidates, null);
		assert.equal(plan.apply, null);
		assert.deepEqual(plan.replaceWithLink, []);
		assert.equal(plan.blocked.length, 3, "the would-be edits are reported, not performed");
		assert.equal(plan.preserve.length, 2, "records are still preserved and still reported");
	});

	test("an authoritative path that matched nothing blocks the pass too", () => {
		const plan = planSweep([note("brain/Gotchas.md")], "reference/Nowhere.md");
		assert.equal(plan.apply, null);
		assert.deepEqual(plan.blocked.map((c) => c.rel), ["brain/Gotchas.md"]);
	});

	test("a sweep over only records edits nothing and loses nothing", () => {
		const plan = planSweep([note("work/archive/2026/Intake.md")], AUTH);
		assert.equal(plan.apply, null);
		assert.deepEqual(plan.preserve.map((c) => c.rel), ["work/archive/2026/Intake.md"]);
	});
});
