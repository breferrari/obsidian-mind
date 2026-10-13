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
	enveloped,
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
import { hookContext, runScript as spawnHook, rmTemp } from "./_helpers.ts";

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

	test("a `fit` level's predicate accepts a body that fills the budget exactly, and not one byte more", () => {
		const fixed: BudgetSection = { header: "", body: "x".repeat(10), priority: 0 };
		const longest = (fits: (body: string) => boolean) => {
			let n = 0;
			while (fits("t".repeat(n + 1))) n++;
			return n > 0 ? "t".repeat(n) : null;
		};
		const s = ns("F".repeat(500), [{ name: "top-N", fit: longest }]);
		const r = applyInjectionBudget([fixed, s], 200);
		assert.equal(r.bytes, 200, "the longest body the predicate accepts fills the budget to the byte");
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
		assert.equal(topHeadlines(heads, (b) => bytes(b) <= bytes(two)), two);
		assert.equal(topHeadlines(heads, (b) => bytes(b) <= bytes(two) - 1), `${renderHeadlines(["one"])}\n_(+2 more goals in brain/North Star.md)_`);
	});
	test("null when not one fits", () => {
		assert.equal(topHeadlines(heads, (b) => bytes(b) <= 5), null);
	});
	// Showing every headline is the `headlines` level, tried before this one,
	// so this level starts one short of all of them, even when all would fit (#371).
	test("one short of all, even when every headline fits", () => {
		assert.equal(topHeadlines(heads, () => true), `${renderHeadlines(["one", "two"])}\n_(+1 more goals in brain/North Star.md)_`);
		assert.equal(topHeadlines(["only"], () => true), null);
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
			const run = spawnHook(resolve(dirname(fileURLToPath(import.meta.url)), "../session-start.ts"), { source: "startup" }, { CLAUDE_PROJECT_DIR: dir });
			const { code } = run;
			const stdout = hookContext(run.stdout);
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

/**
 * Every live goal is delivered at `full`, and any cut is in the meter.
 *
 * `full` kept the old 30-line cap, counted from the `## Current Focus`
 * heading, so on a 30-goal North Star goals 29 and 30 were dropped with 7.9 kB
 * of a 20 kB budget unused — no trailer, and the meter said nothing was
 * degraded. A session not reading the file reported 28 of 30 goals.
 */
describe("North Star full level — no silent cut", () => {
	const goals = Array.from(
		{ length: 30 },
		(_, i) => `- [[Area ${i + 1}]] — GOAL-${String(i + 1).padStart(2, "0")} keep the release pipeline building from tags. ${"How it is measured and what counts as done. ".repeat(6)}`,
	);
	const northStar = `---\ndescription: d\n---\n# North Star\n\n## Current Focus\n\n${goals.join("\n")}\n`;

	test("full carries every live goal: no line cap", () => {
		const full = northStarLadder(northStar).full;
		for (let i = 1; i <= 30; i++) assert.ok(full.includes(`GOAL-${String(i).padStart(2, "0")}`), `goal ${i} missing`);
	});

	test("on the 20 kB instruction budget all 30 goals are delivered, and the meter reports no cut or degradation", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-start-thirty-"));
		try {
			mkdirSync(join(dir, "brain"));
			writeFileSync(join(dir, "brain", "North Star.md"), northStar);
			const { stdout, code } = spawnHook(
				resolve(dirname(fileURLToPath(import.meta.url)), "../session-start.ts"),
				{ source: "startup", om_mod: "deliver" },
				{ CLAUDE_PROJECT_DIR: dir },
			);
			assert.equal(code, 0);
			for (let i = 1; i <= 30; i++) assert.ok(stdout.includes(`GOAL-${String(i).padStart(2, "0")}`), `goal ${i} not delivered`);
			const meter = stdout.trim().split("\n").pop() ?? "";
			assert.match(meter, /\/ 20\.0kB budget_$/, `nothing degraded, collapsed, cut or truncated: ${meter}`);
		} finally {
			rmTemp(dir);
		}
	});

	test("a section delivered from a cut of its source is named in the meter, with what was kept", () => {
		const dir = mkdtempSync(join(tmpdir(), "session-start-cutmeter-"));
		try {
			const tasks = Array.from({ length: 14 }, (_, i) => `- [ ] task ${i + 1}`).join("\n");
			writeFileSync(join(dir, "Tasks.md"), `# Tasks\n\n${tasks}\n`);
			const run = spawnHook(
				resolve(dirname(fileURLToPath(import.meta.url)), "../session-start.ts"),
				{ source: "startup" },
				{ CLAUDE_PROJECT_DIR: dir },
			);
			const { code } = run;
			const stdout = hookContext(run.stdout);
			assert.equal(code, 0);
			const meter = stdout.trim().split("\n").pop() ?? "";
			assert.match(meter, / — cut: Open Tasks \(10 of 14\)/, meter);
		} finally {
			rmTemp(dir);
		}
	});

	test("the allocator reports a cut section only while it is delivered at full", () => {
		const cutSection: BudgetSection = { header: "### Recent", body: "r".repeat(200), priority: 20, fallback: "(r)", cut: "15 of 22" };
		const whole = applyInjectionBudget([cutSection], 10_000);
		assert.deepEqual(whole.cut, [{ section: "Recent", note: "15 of 22" }]);
		const pointer = applyInjectionBudget([cutSection], 50);
		assert.deepEqual(pointer.cut, [], "at its pointer the section is collapsed, which the meter already says");
		assert.deepEqual(pointer.collapsed, ["Recent"]);
	});

	test("the meter prints cuts after degradation", () => {
		assert.equal(
			formatInjectionSize(2_000, { budgetBytes: 9_100, cutSections: [{ section: "Open Tasks", note: "10 of 14" }] }),
			"_context injected: 2.0kB / 9.1kB budget — cut: Open Tasks (10 of 14)_",
		);
	});
});

describe("the budget measures what goes out inside the JSON envelope (#340)", () => {
	// Quotes and newlines escape to two characters each, so a section that fits
	// a budget in bytes can be over it once encoded. Measured enveloped, the
	// budget lets it fall back to its pointer instead of leaving the backstop
	// to truncate the output mid-section.
	const quoted: BudgetSection = { header: "### Quoted", body: '"'.repeat(5_000), priority: 10, fallback: "(pointer)" };

	test("measured in bytes it fits whole; measured enveloped it falls back", () => {
		assert.deepEqual(applyInjectionBudget([quoted], 6_000).collapsed, []);
		assert.deepEqual(applyInjectionBudget([quoted], 6_000, enveloped).collapsed, ["Quoted"]);
	});

	test("enveloped never measures smaller than bytes, so multi-byte text is held as tightly as before", () => {
		const cjk = "界".repeat(1_000);
		assert.equal(enveloped(cjk), Buffer.byteLength(cjk, "utf-8"));
		assert.ok(enveloped('a"b\nc') > Buffer.byteLength('a"b\nc', "utf-8"));
	});
});

describe("a fitted rung sizes itself as the budget measures it (#340)", () => {
	// North Star's top-N rung fits its body into the room the budget leaves.
	// Fitted in raw bytes while the budget measures the encoded text, its body
	// was always a little over once escaped, so the rung was never taken and
	// the goals fell to their pointer.
	test("under the enveloped measure, North Star still degrades to top-N rather than collapsing", () => {
		const headlines = Array.from({ length: 40 }, (_, i) => `- goal ${i} keep the release pipeline building from tags`);
		const fixed: BudgetSection = { header: "### Fixed", body: "f".repeat(2_000), priority: 1 };
		const northStar: BudgetSection = {
			header: "### North Star (current goals)",
			body: headlines.join("\n"),
			priority: 10,
			fallback: "(pointer)",
			levels: [{ name: "top-N", fit: (fits) => topHeadlines(headlines, fits) }],
		};
		for (const budget of [2_600, 2_800, 3_000]) {
			const r = applyInjectionBudget([fixed, northStar], budget, enveloped);
			assert.deepEqual(r.collapsed, [], `budget ${budget}: collapsed`);
			assert.deepEqual(r.degraded, [{ section: "North Star (current goals)", level: "top-N" }], `budget ${budget}`);
		}
	});
	test("top-N keeps every headline the whole render has room for, whatever the rest of it measures", () => {
		// enveloped is max(bytes, json) of the WHOLE render, which is not the sum
		// of its parts: multi-byte text elsewhere pays for this body's escapes.
		const headlines = Array.from({ length: 60 }, (_, i) => `- goal ${i}`);
		const fixed: BudgetSection = { header: "### Fixed", body: "語".repeat(700), priority: 1 };
		const northStar = (body: string): BudgetSection => ({
			header: "### North Star (current goals)",
			body,
			priority: 10,
			fallback: "(pointer)",
			levels: [{ name: "top-N", fit: (fits) => topHeadlines(headlines, fits) }],
		});
		const full = northStar(headlines.join("\n"));
		const textOf = (body: string) => `### Fixed\n${fixed.body}\n\n### North Star (current goals)\n${body}`;
		for (const budget of [2_400, 2_500, 2_600]) {
			// The most headlines any top-N body could keep inside this budget.
			let best = 0;
			for (let n = 1; n < headlines.length; n++) {
				const body = `${renderHeadlines(headlines.slice(0, n))}\n_(+${headlines.length - n} more goals in brain/North Star.md)_`;
				if (enveloped(textOf(body)) <= budget) best = n;
			}
			assert.ok(best > 0, `budget ${budget} leaves room for at least one`);
			const r = applyInjectionBudget([fixed, full], budget, enveloped);
			assert.ok(r.text.includes(`(+${headlines.length - best} more goals`), `budget ${budget}: kept fewer than ${best}`);
		}
	});
});
