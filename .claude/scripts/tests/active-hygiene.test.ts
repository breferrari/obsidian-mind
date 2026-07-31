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
	parseMemoryRoot,
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

	test("the shipped inbox README never counts as pressure (#155)", () => {
		// Isolated root: the shared fixture already holds a real export, and
		// the point here is what an *untouched* inbox reports.
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-scaffold-"));
		try {
			mkdirSync(join(solo, "work/meetings"), { recursive: true });
			const scaffold = join(solo, "work/meetings/README.md");
			writeFileSync(scaffold, "# Meeting Notes Inbox\n\nDrop exports here.\n");
			// Well past the 7-day threshold — the age the flag kept climbing to.
			const t = new Date(NOW - 96 * DAY_MS);
			utimesSync(scaffold, t, t);

			// The bug: an inbox holding nothing but its own scaffold flagged
			// forever, and /om-intake could never clear it.
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).inboxPressure, null);

			// …while a genuine export beside it still counts, and counts once.
			const real = join(solo, "work/meetings/2026-04-01 Standup.md");
			writeFileSync(real, "raw dump");
			utimesSync(real, t, t);
			const withExport = scanActiveHygiene(solo, NOW, DEFAULTS).inboxPressure;
			assert.ok(withExport !== null);
			assert.equal(withExport!.count, 1);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	test("the cross-repo memory inbox is counted, nested under year and month", () => {
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-"));
		try {
			mkdirSync(join(solo, "memories/2026/07"), { recursive: true });
			const a = join(solo, "memories/2026/07/a lesson.md");
			writeFileSync(a, "captured");
			const t = new Date(NOW - 3 * DAY_MS);
			utimesSync(a, t, t);

			// The defect this closes: every other scan here is flat, and the server
			// writes two levels down, so a flat walk reports an empty inbox forever.
			const found = scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox;
			assert.ok(found !== null);
			assert.equal(found!.count, 1);
			assert.equal(found!.oldestDays, 3);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	test("a memory capture counts the moment it lands — no age threshold", () => {
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-fresh-"));
		try {
			mkdirSync(join(solo, "memories/2026/07"), { recursive: true });
			writeFileSync(join(solo, "memories/2026/07/brand new.md"), "captured");
			// Undrained because nobody has judged it, which is true immediately.
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox?.count, 1);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	test("a shipped README in the memory tree is not a capture", () => {
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-readme-"));
		try {
			mkdirSync(join(solo, "memories/2026/07"), { recursive: true });
			writeFileSync(join(solo, "memories/2026/07/README.md"), "how this folder works");
			// Same permanently-unclearable trap the meetings scaffold already fixed.
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox, null);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	test("a declared memory_root is honoured, and the default is not hard-coded", () => {
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-root-"));
		try {
			mkdirSync(join(solo, "elsewhere/2026/07"), { recursive: true });
			writeFileSync(join(solo, "elsewhere/2026/07/a lesson.md"), "captured");
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox, null);
			assert.equal(
				scanActiveHygiene(solo, NOW, DEFAULTS, [], parseMemoryRoot('{"memory_root":"elsewhere"}'))
					.memoryInbox?.count,
				1,
			);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	// The flag has to be able to reach zero. Promotion is additive, so the entry
	// stays; without a marker the count could only ever grow, which is the
	// permanently-unclearable failure #155 already fixed once.
	test("a promoted capture stops counting, so the flag can clear", () => {
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-promoted-"));
		try {
			mkdirSync(join(solo, "memories/2026/07"), { recursive: true });
			const rel = "memories/2026/07/a lesson.md";
			writeFileSync(join(solo, rel), "---\nscope: general\n---\n\n# a lesson\n");
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox?.count, 1);

			writeFileSync(
				join(solo, rel),
				'---\nscope: general\npromoted: "brain/Gotchas"\n---\n\n# a lesson\n',
			);
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox, null);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	/**
	 * The gradient the count creates (#183).
	 *
	 * Clearing the flag and SERVING the lesson are different achievements, and a
	 * bare marker buys the first for less work than the second. Hygiene reports
	 * the split so the cheaper form is visible — but it must never gate on it, or
	 * the flag stops being able to reach zero.
	 */
	test("a bare marker is counted as named-only, and never revives the flag", () => {
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-namedonly-"));
		try {
			mkdirSync(join(solo, "memories/2026/07"), { recursive: true });
			writeFileSync(
				join(solo, "memories/2026/07/bare.md"),
				'---\nscope: general\npromoted: "brain/Gotchas"\n---\n\n# bare\n',
			);
			writeFileSync(
				join(solo, "memories/2026/07/anchored.md"),
				'---\nscope: general\npromoted: "brain/Gotchas#^om-a1b2c3"\n---\n\n# anchored\n',
			);

			// Both are promoted, so there is no pressure at all — the flag reaches
			// zero exactly as before, which is the invariant #155 established.
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox, null);

			// Add one UNpromoted capture: the flag fires, and the split rides on it
			// as a detail rather than as a second warning of its own.
			writeFileSync(join(solo, "memories/2026/07/fresh.md"), "---\nscope: general\n---\n\n# fresh\n");
			const inbox = scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox;
			assert.equal(inbox?.count, 1, "only the unpromoted capture is pressure");
			assert.equal(inbox?.namedOnly, 1, "the bare marker counts, the anchored one does not");

			const text = formatActiveHygiene(scanActiveHygiene(solo, NOW, DEFAULTS)).join("\n");
			assert.match(text, /1 already-promoted capture\(s\) here carry a bare marker/);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	test("quoting does not change the verdict — the writer stamps a YAML scalar", () => {
		// The capture writer emits `promoted: 'brain/X#^id'`, and hand-promotion
		// writes all three forms below. The count must not depend on which.
		//
		// This does NOT prove the quote stripping in `promotionOf`: an unstripped
		// `"brain/G#^om-a1"` still splits at the `#` and still reads as anchored,
		// so the verdict is identical either way. The stripping is there so the
		// returned ref's `note` is a real path rather than `"brain/G` — which no
		// caller reads today and every caller would assume tomorrow. What this
		// guards is the count, across the forms actually written.
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-quoted-"));
		try {
			mkdirSync(join(solo, "memories/2026/07"), { recursive: true });
			writeFileSync(join(solo, "memories/2026/07/x.md"), "---\nscope: general\n---\n\n# x\n");
			for (const marker of ["'brain/G#^om-a1'", '"brain/G#^om-a1"', "brain/G#^om-a1"]) {
				writeFileSync(
					join(solo, "memories/2026/07/q.md"),
					`---\nscope: general\npromoted: ${marker}\n---\n\n# q\n`,
				);
				assert.equal(
					scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox?.namedOnly,
					0,
					`anchored, however quoted: ${marker}`,
				);
			}
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	test("an empty or misplaced promoted marker does not silence a capture", () => {
		const solo = mkdtempSync(join(tmpdir(), "active-hygiene-memories-badmark-"));
		try {
			mkdirSync(join(solo, "memories/2026/07"), { recursive: true });
			// A bare key with no value is not a promotion record and must not hide
			// a capture from review.
			writeFileSync(join(solo, "memories/2026/07/x.md"), "---\npromoted:\n---\n\n# x\n");
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox?.count, 1);
			// Nor may the word appearing in the BODY rather than the frontmatter.
			writeFileSync(join(solo, "memories/2026/07/y.md"), "# y\n\npromoted: brain/Thing\n");
			assert.equal(scanActiveHygiene(solo, NOW, DEFAULTS).memoryInbox?.count, 2);
		} finally {
			rmSync(solo, { recursive: true, force: true });
		}
	});

	test("the memory-inbox line says COPY, never delete", () => {
		const lines = formatActiveHygiene({
			completedInActive: [],
			ungroupedClusters: [],
			oversizedNotes: [],
			openLoops: [],
			inboxPressure: null,
			memoryInbox: { count: 4, oldestDays: 2, namedOnly: 0 },
		});
		const text = lines.join("\n");
		assert.match(text, /COPYING it/);
		// The ANCHORED form is what the prompt must teach: a bare marker clears
		// this very count while serving nothing, so a warning that showed only
		// the bare form would be steering the reader to the useless one.
		assert.match(text, /promoted: "brain\/Note#\^om-a1b2c3"/);
		assert.match(text, /a bare `promoted: <note>` clears this count but serves nothing/);
		assert.doesNotMatch(text, /om-intake/);
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
			memoryInbox: null,
		});
		const text = lines.join("\n");
		assert.match(text, /marked done but still in active\//);
		assert.match(text, /SPLIT/);
		assert.match(text, new RegExp(`${OPEN_LOOP_DAYS}\\+ days`));
		assert.doesNotMatch(text, /om-intake/); // silent segment omitted
	});
});
