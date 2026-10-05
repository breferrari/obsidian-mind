/**
 * #304: the eager layer degrades by levels, not all-or-nothing.
 *
 * Before, `applyInjectionBudget` collapsed sections worst-first and stopped at
 * the first fit, with nothing between a whole section and its pointer. A long
 * North Star could not fit whole, so after the file listing and brain index
 * were given up — though they fitted — it collapsed too: 0.4 kB injected of a
 * 9.1 kB budget, and no goals. These pin the ladder that replaced it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	applyInjectionBudget,
	formatInjectionSize,
	goalHeadline,
	northStarLadder,
	renderHeadlines,
	stripFrontmatter,
	take,
	topHeadlines,
	HEADLINE_MAX_CHARS,
	NORTH_STAR_POINTER,
	type BudgetSection,
} from "../lib/session-start.ts";
import { runScript as spawnHook, rmTemp } from "./_helpers.ts";

const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");
const render = (s: readonly BudgetSection[]): number =>
	bytes(s.map((x) => (x.header === "" ? x.body : `${x.header}\n${x.body}`)).join("\n\n"));

describe("applyInjectionBudget — the ladder", () => {
	const ns = (full: string, levels: BudgetSection["levels"]): BudgetSection => ({
		header: "### North Star (current goals)",
		body: full,
		priority: 30,
		fallback: NORTH_STAR_POINTER,
		levels,
	});
	const listing: BudgetSection = { header: "### Vault File Listing", body: "l".repeat(400), priority: 50, fallback: "(l)" };
	const brain: BudgetSection = { header: "### Brain Topics (read on demand)", body: "b".repeat(400), priority: 40, fallback: "(b)" };

	test("#304's shape: an oversized North Star degrades to headlines; the listing and brain index stay whole", () => {
		const r = applyInjectionBudget(
			[listing, brain, ns("n".repeat(12_000), [{ name: "headlines", body: "- goal one\n- goal two" }])],
			2_000,
		);
		assert.ok(r.text.includes("l".repeat(400)));
		assert.ok(r.text.includes("b".repeat(400)));
		assert.ok(r.text.includes("- goal one\n- goal two"));
		assert.deepEqual(r.collapsed, []);
		assert.deepEqual(r.degraded, [{ section: "North Star (current goals)", level: "headlines" }]);
	});

	test("a better section is never lowered to raise a worse one", () => {
		// Budget fits Better at full with Worse at its pointer, OR Better at
		// its middle level with Worse whole. Best-first keeps Better whole.
		const better: BudgetSection = { header: "### Better", body: "B".repeat(100), priority: 10, fallback: "(B)", levels: [{ name: "mid", body: "B".repeat(40) }] };
		const worse: BudgetSection = { header: "### Worse", body: "W".repeat(60), priority: 20, fallback: "(W)" };
		const r = applyInjectionBudget([better, worse], 130);
		assert.ok(r.text.includes("B".repeat(100)), r.text);
		assert.deepEqual(r.collapsed, ["Worse"]);
		assert.deepEqual(r.degraded, []);
	});

	test("each level is chosen at its boundary: fits exactly, and one byte over drops a level", () => {
		const fixed: BudgetSection = { header: "", body: "x", priority: 0 };
		const levels = [{ name: "focus", body: "f".repeat(50) }, { name: "headlines", body: "h".repeat(20) }];
		const sections = (full: string) => [fixed, ns(full, levels)];
		const atFocus = render([fixed, { ...ns("", levels), body: "f".repeat(50) }]);
		const atHeadlines = render([fixed, { ...ns("", levels), body: "h".repeat(20) }]);

		const exactFocus = applyInjectionBudget(sections("F".repeat(80)), atFocus);
		assert.deepEqual(exactFocus.degraded, [{ section: "North Star (current goals)", level: "focus" }]);
		assert.equal(exactFocus.bytes, atFocus);

		const overFocus = applyInjectionBudget(sections("F".repeat(80)), atFocus - 1);
		assert.deepEqual(overFocus.degraded, [{ section: "North Star (current goals)", level: "headlines" }]);

		const overHeadlines = applyInjectionBudget(sections("F".repeat(80)), atHeadlines - 1);
		assert.deepEqual(overHeadlines.degraded, []);
		assert.deepEqual(overHeadlines.collapsed, ["North Star (current goals)"]);
	});

	test("a `fit` level is handed exactly the room its body may take", () => {
		const fixed: BudgetSection = { header: "", body: "x".repeat(10), priority: 0 };
		let handed = -1;
		const s = ns("F".repeat(500), [{ name: "top-N", fit: (room) => ((handed = room), "t".repeat(room)) }]);
		const r = applyInjectionBudget([fixed, s], 200);
		assert.equal(r.bytes, 200, "a body of exactly the room handed fills the budget to the byte");
		assert.equal(handed, 200 - render([fixed, { ...s, body: "" }]));
		assert.deepEqual(r.degraded, [{ section: "North Star (current goals)", level: "top-N" }]);
	});

	test("a section whose last given-up rival was the oversized one gets restored (two-step ladders)", () => {
		const big: BudgetSection = { header: "### Big", body: "g".repeat(5_000), priority: 30, fallback: "(g)" };
		const r = applyInjectionBudget([listing, brain, big], 1_000);
		assert.deepEqual(r.collapsed, ["Big"]);
		assert.ok(r.text.includes("l".repeat(400)) && r.text.includes("b".repeat(400)));
	});
});

describe("formatInjectionSize — degraded sections are named with their level", () => {
	test("collapsed keeps its token and meaning; degraded is added after it", () => {
		assert.equal(
			formatInjectionSize(5_000, {
				budgetBytes: 9_100,
				collapsed: ["Vault File Listing"],
				degraded: [{ section: "North Star (current goals)", level: "headlines" }],
			}),
			"_context injected: 5.0kB / 9.1kB budget — collapsed: Vault File Listing — degraded: North Star (current goals) → headlines_",
		);
	});
	test("each level name prints as given", () => {
		for (const level of ["focus", "headlines", "top-N"]) {
			assert.match(
				formatInjectionSize(1_000, { budgetBytes: 2_000, degraded: [{ section: "North Star (current goals)", level }] }),
				new RegExp(`degraded: North Star \\(current goals\\) → ${level}_$`),
			);
		}
	});
	test("nothing degraded → the meter is unchanged", () => {
		assert.equal(formatInjectionSize(1_000, { budgetBytes: 2_000, degraded: [] }), "_context injected: 1.0kB / 2.0kB budget_");
	});
});

describe("goalHeadline", () => {
	test("a [[link]] — clause bullet keeps the whole first sentence, never a dash stub", () => {
		assert.equal(
			goalHeadline("- [[Atlas]] — move the release build onto tagged artifacts so nobody hand-edits. Measure it by releases."),
			"Atlas — move the release build onto tagged artifacts so nobody hand-edits.",
		);
	});
	test("short goals come through whole", () => {
		assert.equal(goalHeadline("- Ship the auth refactor behind a flag by end of Q3"), "Ship the auth refactor behind a flag by end of Q3");
	});
	test("a first sentence under 40 chars is a label: sentences are added until it is not", () => {
		assert.equal(goalHeadline("- [[Atlas]]. Move the release build onto tagged artifacts. Then measure."), "Atlas. Move the release build onto tagged artifacts.");
	});
	test("with nothing to extend into, a short bullet stays whole", () => {
		assert.equal(goalHeadline("- Q4. Two talks."), "Q4. Two talks.");
	});
	test("wikilink aliases and headings render as text; emphasis markers drop", () => {
		assert.equal(goalHeadline("- Write the retro for [[INC 7|the outage]] and **[[Runbook#Paging]]** fixes"), "Write the retro for the outage and Runbook fixes");
	});
	test("capped at the limit on a word boundary with an ellipsis", () => {
		const h = goalHeadline(`- ${"word ".repeat(100)}end`) ?? "";
		assert.ok(h.length <= HEADLINE_MAX_CHARS && h.endsWith("…"), h);
	});
	test("empty, struck, checked and non-list lines are not goals", () => {
		for (const l of ["-", "- ~~done~~", "- [x] done", "## Goals", "_prompt_"]) assert.equal(goalHeadline(l), null, l);
	});
});

/**
 * The old `northStar()` slice, kept verbatim as the oracle for `full`: the
 * new level must equal it except for the documented delta.
 */
function oldNorthStar(raw: string): string {
	const lines = stripFrontmatter(raw).split("\n");
	const anchor = lines.findIndex((l) => l.trim().startsWith("## Current Focus"));
	const scoped = anchor >= 0 ? lines.slice(anchor) : lines;
	const struckCount = scoped.filter((l) => l.trimStart().startsWith("- ~~")).length;
	const live = scoped.filter((l) => !l.trimStart().startsWith("- ~~"));
	if (struckCount > 0) {
		live.splice(1, 0, `_(${struckCount} completed item${struckCount === 1 ? "" : "s"} hidden — full history in brain/North Star.md)_`);
	}
	return take(live.join("\n"), 30);
}

describe("northStarLadder", () => {
	const VAULT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

	test("full equals the old slice on a file with nothing to clean (the shipped template, minus its Shifts Log)", () => {
		const raw = `---\ndate:\n---\n# North Star\n\n## Current Focus\n\n- Ship it\n\n## Goals\n\n- Grow\n`;
		assert.equal(northStarLadder(raw).full, oldNorthStar(raw));
	});

	test("full differs from the old slice by exactly: finished items' children, [x] items, and the Shifts Log", () => {
		const raw = [
			"## Current Focus",
			"- Live goal",
			"- ~~Old goal~~",
			"  - a sub-bullet of the old goal",
			"- [x] Checked goal",
			"  continuation of the checked goal",
			"- Another live goal",
			"",
			"## Shifts Log",
			"",
			"| Date | Shift | Reason |",
			"| 2026-01-01 | Created | Setup |",
			"",
			"## Anti-goals",
			"- Not this",
		].join("\n");
		const before = oldNorthStar(raw).split("\n");
		const after = northStarLadder(raw).full.split("\n");
		const gone = before.filter((l) => !after.includes(l));
		assert.deepEqual(gone, [
			"_(1 completed item hidden — full history in brain/North Star.md)_",
			"  - a sub-bullet of the old goal",
			"- [x] Checked goal",
			"  continuation of the checked goal",
			"## Shifts Log",
			"| Date | Shift | Reason |",
			"| 2026-01-01 | Created | Setup |",
		]);
		assert.ok(after.includes("_(2 completed items hidden — full history in brain/North Star.md)_"));
		assert.ok(after.includes("## Anti-goals") && after.includes("- Not this"), "later goal sections stay in full");
	});

	test("focus is Current Focus only; headlines are its live top-level bullets", () => {
		const raw = "## Current Focus\n- [[Alpha]] — the first goal, stated in one full sentence. More.\n  - detail\n- ~~done~~\n\n## Goals\n- Later";
		const l = northStarLadder(raw);
		assert.equal(l.focus, "## Current Focus\n_(1 completed item hidden — full history in brain/North Star.md)_\n- [[Alpha]] — the first goal, stated in one full sentence. More.\n  - detail");
		assert.deepEqual(l.headlines, ["Alpha — the first goal, stated in one full sentence."]);
	});

	test("the shipped template yields no headlines (its bullets are empty), so the ladder skips those levels", () => {
		const l = northStarLadder(readFileSync(join(VAULT, "brain", "North Star.md"), "utf-8"));
		assert.deepEqual(l.headlines, []);
		assert.ok(!l.full.includes("Shifts Log"));
	});
});

describe("topHeadlines", () => {
	const heads = ["one", "two", "three"];
	test("the first N that fit, and how many more", () => {
		const two = `${renderHeadlines(["one", "two"])}\n_(+1 more goals in brain/North Star.md)_`;
		assert.equal(topHeadlines(heads, bytes(two)), two);
		assert.equal(topHeadlines(heads, bytes(two) - 1), `${renderHeadlines(["one"])}\n_(+2 more goals in brain/North Star.md)_`);
	});
	test("null when not one fits", () => {
		assert.equal(topHeadlines(heads, 5), null);
	});
});

describe("session-start — #304's fixture on the hook path", () => {
	test("30 long [[link]] — clause bullets: goals reach the session, listing and brain index stay", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-start-ladder-"));
		try {
			mkdirSync(join(dir, "brain"));
			const clause = "move the release build onto tagged artifacts so nobody edits the changelog by hand. ";
			const bullets = Array.from({ length: 30 }, (_, i) => `- [[Project ${i}]] — ${clause}${"More detail on how it is measured and what counts. ".repeat(5)}`);
			writeFileSync(join(dir, "brain", "North Star.md"), `---\ndescription: d\n---\n# North Star\n\n## Current Focus\n\n${bullets.join("\n")}\n`);
			writeFileSync(join(dir, "brain", "Gotchas.md"), "---\ndescription: pitfalls\n---\n# G\n");
			const { stdout, code } = spawnHook(resolve(dirname(fileURLToPath(import.meta.url)), "../session-start.ts"), { source: "startup" }, { CLAUDE_PROJECT_DIR: dir });
			assert.equal(code, 0);
			const ns = stdout.slice(stdout.indexOf("### North Star"), stdout.indexOf("\n### ", stdout.indexOf("### North Star") + 5));
			assert.match(ns, /- Project 0 — move the release build onto tagged artifacts/);
			assert.ok(!ns.includes(NORTH_STAR_POINTER), "goals, not the pointer");
			assert.match(stdout, /### Brain Topics[^\n]*\n[^(]*Gotchas/);
			const meter = stdout.trim().split("\n").pop() ?? "";
			assert.doesNotMatch(meter, /collapsed:/, meter);
			assert.match(meter, /degraded: North Star \(current goals\) → (headlines|top-N)_$/);
		} finally {
			rmTemp(dir);
		}
	});
});
