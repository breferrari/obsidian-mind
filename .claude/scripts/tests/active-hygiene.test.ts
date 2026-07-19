/**
 * Unit tests for lib/active-hygiene.ts — the drift detectors behind the
 * SessionStart/Stop hygiene section and validate-write's write-time flags.
 * Temp-dir fixtures with utimesSync-backdated mtimes; `now` is injected so
 * age thresholds are deterministic.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	utimesSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	MONOLITH_BYTES,
	OPEN_LOOP_DAYS,
	countOpenLoops,
	formatActiveHygiene,
	formatClusterHint,
	formatMonolithHint,
	isMonolithExempt,
	newNoteClusterCandidate,
	parseOpenLoopConfig,
	scanActiveHygiene,
	walkMarkdown,
} from "../lib/active-hygiene.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 13);
const DEFAULTS = parseOpenLoopConfig(null);

let ROOT: string;

function writeAged(rel: string, content: string, ageDays: number): void {
	const full = join(ROOT, rel);
	writeFileSync(full, content);
	const t = new Date(NOW - ageDays * DAY_MS);
	utimesSync(full, t, t);
}

before(() => {
	ROOT = mkdtempSync(join(tmpdir(), "active-hygiene-test-"));
	for (const d of [
		"work/active/Grouped Topic",
		"work/1-1",
		"work/meetings",
		"work/incidents",
		"templates",
	]) {
		mkdirSync(join(ROOT, d), { recursive: true });
	}
});

after(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("parseOpenLoopConfig", () => {
	test("defaults when manifest is null or lacks the fields", () => {
		const cfg = parseOpenLoopConfig(null);
		assert.deepEqual(cfg.dirs, ["work/1-1", "work/meetings", "work/incidents"]);
		assert.equal(cfg.sectionRe.test("## Action Items"), true);
		assert.equal(cfg.sectionRe.test("### What to Watch"), true);
		assert.equal(cfg.sectionRe.test("## Notes"), false);
	});
	test("manifest overrides both dirs and sections", () => {
		const cfg = parseOpenLoopConfig(
			JSON.stringify({
				open_loop_dirs: ["people", "outreach"],
				open_loop_sections: ["next steps"],
			}),
		);
		assert.deepEqual(cfg.dirs, ["people", "outreach"]);
		assert.equal(cfg.sectionRe.test("## Next Steps"), true);
		assert.equal(cfg.sectionRe.test("## Action Items"), false);
	});
	test("rejects traversal-shaped dirs: absolute, dot-dot, backslash, drive-letter", () => {
		const cfg = parseOpenLoopConfig(
			JSON.stringify({
				open_loop_dirs: ["../outside", "/etc", "C:evil", "ok/dir", "a\\b", "x/../y"],
			}),
		);
		assert.deepEqual(cfg.dirs, ["ok/dir"]);
		const allBad = parseOpenLoopConfig(
			JSON.stringify({ open_loop_dirs: ["../a", "/b"] }),
		);
		assert.deepEqual(allBad.dirs, ["work/1-1", "work/meetings", "work/incidents"]);
	});

	test("malformed values fall back to defaults (incl. regex metachars escaped)", () => {
		const cfg = parseOpenLoopConfig(
			JSON.stringify({ open_loop_dirs: [], open_loop_sections: [42] }),
		);
		assert.deepEqual(cfg.dirs, ["work/1-1", "work/meetings", "work/incidents"]);
		const meta = parseOpenLoopConfig(
			JSON.stringify({ open_loop_sections: ["a.b (c)"] }),
		);
		assert.equal(meta.sectionRe.test("## a.b (c)"), true);
		assert.equal(meta.sectionRe.test("## aXb (c)"), false);
	});
});

describe("countOpenLoops", () => {
	test("counts unchecked boxes only inside configured sections", () => {
		const note = [
			"# 1:1",
			"## Action Items",
			"- [ ] chase reply",
			"- [x] done thing",
			"## Notes",
			"- [ ] checkbox outside a follow-up section",
		].join("\n");
		assert.equal(countOpenLoops(note, DEFAULTS.sectionRe), 1);
	});
	test("counts waiting-on / watch-for phrase lines anywhere", () => {
		assert.equal(
			countOpenLoops("waiting on legal\nWatch for the rollout\n", DEFAULTS.sectionRe),
			2,
		);
	});
	test("clean note counts zero", () => {
		assert.equal(countOpenLoops("# all wrapped\n", DEFAULTS.sectionRe), 0);
	});
});

describe("scanActiveHygiene — detectors", () => {
	test("flags completed notes in active/ (recursively), ignores active ones", () => {
		writeAged(
			"work/active/Live Project.md",
			"---\nstatus: active\n---\n# live\n",
			1,
		);
		writeAged(
			"work/active/Grouped Topic/Done Sub.md",
			"---\nstatus: completed\n---\n# done\n",
			1,
		);
		const report = scanActiveHygiene(ROOT, NOW, DEFAULTS);
		assert.deepEqual(report.completedInActive, [
			"work/active/Grouped Topic/Done Sub.md",
		]);
	});

	test("clusters loose root notes sharing a distinctive token; DF guard rejects common words", () => {
		for (const f of [
			"Payments Migration.md",
			"Payments Rollout.md",
			"Hiring Loop.md",
			"Vendor Selection.md",
			"Quarterly Budget.md",
		]) {
			writeAged(`work/active/${f}`, "# x\n", 1);
		}
		const report = scanActiveHygiene(ROOT, NOW, DEFAULTS);
		const tokens = report.ungroupedClusters.map((c) => c.token);
		assert.ok(tokens.includes("payments"), `expected payments in ${tokens}`);
		// Subfoldered notes never cluster; a token in >half the root is rejected.
		for (const c of report.ungroupedClusters) {
			assert.ok(!c.files.some((f) => f.includes("/")));
		}
	});

	test("flags oversized notes vault-wide, exempts Archive names and skip dirs", () => {
		writeAged("work/Fat Log.md", "x".repeat(MONOLITH_BYTES + 1000), 1);
		writeAged("work/Fat Log Archive.md", "x".repeat(60_000), 1);
		writeAged("templates/Huge Template.md", "x".repeat(60_000), 1);
		const report = scanActiveHygiene(ROOT, NOW, DEFAULTS);
		const paths = report.oversizedNotes.map((o) => o.path);
		assert.ok(paths.includes("work/Fat Log.md"));
		assert.ok(!paths.some((p) => p.includes("Archive")));
		assert.ok(!paths.some((p) => p.startsWith("templates/")));
	});

	test("open loops: quiet notes with live signals flagged; 1:1 dirs reduce to latest per person", () => {
		writeAged(
			"work/1-1/Alice 2026-05-01.md",
			"## Action Items\n- [ ] old carried item\n",
			70,
		);
		writeAged(
			"work/1-1/Alice 2026-06-20.md",
			"## Action Items\n- [ ] current item\n",
			23,
		);
		writeAged("work/incidents/Payment Outage.md", "watch for regression\n", 30);
		writeAged("work/meetings/Fresh Sync.md", "waiting on vendor\n", 2);
		const report = scanActiveHygiene(ROOT, NOW, DEFAULTS);
		const paths = report.openLoops.map((l) => l.path);
		assert.ok(paths.includes("work/1-1/Alice 2026-06-20.md"));
		assert.ok(!paths.includes("work/1-1/Alice 2026-05-01.md")); // older 1:1 skipped
		assert.ok(paths.includes("work/incidents/Payment Outage.md"));
		assert.ok(!paths.includes("work/meetings/Fresh Sync.md")); // too fresh
		// Oldest first.
		const ages = report.openLoops.map((l) => l.ageDays);
		assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
	});

	test("overlapping configured dirs do not double-count a file", () => {
		const cfg = parseOpenLoopConfig(
			JSON.stringify({ open_loop_dirs: ["work", "work/incidents"] }),
		);
		const report = scanActiveHygiene(ROOT, NOW, cfg);
		const hits = report.openLoops.filter(
			(l) => l.path === "work/incidents/Payment Outage.md",
		);
		assert.equal(hits.length, 1);
	});

	test("meetings-inbox pressure counts week-old raw exports", () => {
		writeAged("work/meetings/2026-06-01 Raw Export.md", "raw dump", 40);
		const report = scanActiveHygiene(ROOT, NOW, DEFAULTS);
		assert.ok(report.inboxPressure !== null);
		assert.ok(report.inboxPressure!.count >= 1);
		assert.ok(report.inboxPressure!.oldestDays >= 40);
	});

	test("missing folders produce an empty report, not errors", () => {
		const empty = mkdtempSync(join(tmpdir(), "active-hygiene-empty-"));
		try {
			const report = scanActiveHygiene(empty, NOW, DEFAULTS);
			assert.deepEqual(report.completedInActive, []);
			assert.deepEqual(report.ungroupedClusters, []);
			assert.deepEqual(report.oversizedNotes, []);
			assert.deepEqual(report.openLoops, []);
			assert.equal(report.inboxPressure, null);
			assert.deepEqual(formatActiveHygiene(report), []);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("write-time detectors", () => {
	test("newNoteClusterCandidate fires for a loose root note in a cluster, not for subfoldered or outside paths", () => {
		const hit = newNoteClusterCandidate(
			join(ROOT, "work/active/Payments Migration.md"),
			ROOT,
		);
		assert.ok(hit !== null && hit.token === "payments");
		assert.equal(
			newNoteClusterCandidate(
				join(ROOT, "work/active/Grouped Topic/Done Sub.md"),
				ROOT,
			),
			null,
		);
		assert.equal(
			newNoteClusterCandidate(join(ROOT, "brain/Patterns.md"), ROOT),
			null,
		);
	});

	test("hints carry the judgment framing", () => {
		const hint = formatClusterHint({
			token: "payments",
			files: ["Payments A.md", "Payments B.md"],
		});
		assert.match(hint, /Token overlap is BLIND/);
		assert.match(hint, /active\/<Topic>\//);
		const mono = formatMonolithHint("work/Fat.md", 42_000);
		assert.match(mono, /Do NOT trim/);
		assert.match(mono, /42KB/);
	});

	test("isMonolithExempt covers Archive names only", () => {
		assert.equal(isMonolithExempt("Delivery Log Archive.md"), true);
		assert.equal(isMonolithExempt("Delivery Log.md"), false);
	});
});

describe("walkMarkdown", () => {
	test("recurses into subfolders and tolerates missing dirs", () => {
		const files = walkMarkdown(ROOT, "work/active");
		assert.ok(files.includes("work/active/Grouped Topic/Done Sub.md"));
		assert.deepEqual(walkMarkdown(ROOT, "no/such/dir"), []);
	});
});

describe("formatActiveHygiene", () => {
	test("renders one block per drift mode, silent segments omitted", () => {
		const lines = formatActiveHygiene({
			completedInActive: ["work/active/Done.md"],
			ungroupedClusters: [],
			oversizedNotes: [{ path: "work/Fat.md", sizeKb: 40 }],
			openLoops: [{ path: "work/1-1/A 2026-01-01.md", ageDays: 20, openItems: 2 }],
			inboxPressure: null,
		});
		const text = lines.join("\n");
		assert.match(text, /marked done but still in active\//);
		assert.match(text, /SPLIT/);
		assert.match(text, new RegExp(`${OPEN_LOOP_DAYS}\\+ days`));
		assert.doesNotMatch(text, /om-intake/); // silent segment omitted
	});
});
