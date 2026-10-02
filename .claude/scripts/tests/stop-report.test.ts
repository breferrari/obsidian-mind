/**
 * lib/stop-report.ts: the user's one-line-per-section summary of a Stop
 * report, and the preface the agent reads with the full one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PREFACE, SUMMARY_TRAILER, stopSummary } from "../lib/stop-report.ts";
import { formatActiveHygiene, INBOX_PRESSURE_DAYS, MONOLITH_BYTES } from "../lib/active-hygiene.ts";

const CHECKLIST = "Wrap-up checklist: archive · indexes";
const HYGIENE = [
	"⚠️  2 note(s) marked done but still in active/ — archive to archive/YYYY/ (ask the agent to run om-project-archive):",
	"   - work/active/A.md",
	"   - work/active/B.md",
	"",
	"⚠️  1 note(s) past the 25KB organization threshold — do NOT trim content; SPLIT (domain notes / event-log satellites):",
	"   - notes/Big.md (30KB)",
];

describe("stopSummary", () => {
	test("the checklist line, one Hygiene line of claims, then where the detail went", () => {
		assert.deepEqual(stopSummary(CHECKLIST, HYGIENE).split("\n"), [
			CHECKLIST,
			"Hygiene: 2 note(s) marked done but still in active/ · 1 note(s) past the 25KB organization threshold",
			SUMMARY_TRAILER,
		]);
	});

	test("no file lists or instructions reach the user", () => {
		assert.doesNotMatch(stopSummary(CHECKLIST, HYGIENE), /work\/active\/A\.md|notes\/Big\.md|do NOT trim|om-project-archive/);
	});

	test("every finding the scan can raise reduces to its claim", () => {
		// The real formatter, so a reworded finding is tested as it ships.
		const lines = formatActiveHygiene({
			completedInActive: ["work/active/Done.md"],
			ungroupedClusters: [{ token: "alpha", files: ["Alpha Plan.md", "Alpha Risks.md"] }],
			oversizedNotes: [{ path: "notes/Big.md", sizeKb: 30 }],
			openLoops: [{ path: "work/1-1/Weekly.md", ageDays: 20, openItems: 2 }],
			inboxPressure: { count: 2, oldestDays: 9 },
			memoryInbox: { count: 4, oldestDays: 2, namedOnly: 1 },
		});
		const hygiene = stopSummary(CHECKLIST, lines).split("\n")[1] ?? "";
		assert.deepEqual(hygiene.replace(/^Hygiene: /, "").split(" · "), [
			"1 note(s) marked done but still in active/",
			"Loose active/ notes that look like one topic",
			`1 note(s) past the ${MONOLITH_BYTES / 1000}KB organization threshold`,
			"1 note(s) with open follow-ups untouched 14+ days",
			`2 raw export(s) sitting in work/meetings/ for ${INBOX_PRESSURE_DAYS}+ days`,
			"4 cross-repo memory capture(s) awaiting review",
		]);
	});

	test("only a finding's first line is a claim: an indented line is detail, whatever it starts with", () => {
		const lines = ["⚠️  1 note(s) marked done but still in active/ — archive:", "   ⚠️ notes/odd-name.md"];
		assert.equal(stopSummary(CHECKLIST, lines).split("\n")[1], "Hygiene: 1 note(s) marked done but still in active/");
	});

	test("a clean vault is the checklist line and the trailer", () => {
		assert.deepEqual(stopSummary(CHECKLIST, []).split("\n"), [CHECKLIST, SUMMARY_TRAILER]);
	});
});

describe("AGENT_PREFACE", () => {
	test("tells the agent the report arrived with the user's message, which comes first", () => {
		assert.match(AGENT_PREFACE, /^Stop hook report, handed over with this message: /);
		assert.match(AGENT_PREFACE, /Deal with the user's message first/);
		assert.match(AGENT_PREFACE, /The user saw only a one-line summary of each section/);
	});
});
