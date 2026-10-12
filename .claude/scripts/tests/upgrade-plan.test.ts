/**
 * The ahead/behind judgment behind `/om-vault-upgrade` (#101), on plans
 * shaped exactly like ShardMind 0.2.0's `--dry-run --json` output.
 *
 * ShardMind's bulk modes cannot tell a file the user improved from one the
 * user never updated. Measured on a real 9.0.0 → 9.0.1 clone with one local
 * edit: `adopt --mode keep-all-mine` reported the vault "9.0.1, up to date"
 * while four files stayed at 9.0.0, recorded as user-modified so that no
 * later update would touch them. These pin the classification that avoids it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	classifyAdopt,
	classifyUpdate,
	formatUpgradeReport,
	instructionFilesReady,
	settleFirst,
	untouchedRetiredFiles,
	withRetiredInstructionFiles,
	type AdoptPlan,
	type UpdatePlan,
} from "../lib/upgrade-plan.ts";

describe("classifyUpdate — a managed vault", () => {
	const plan: UpdatePlan = {
		dryRun: true,
		files: [
			{ path: "CHANGELOG.md", action: "overwrite" },
			{ path: "vault-manifest.json", action: "overwrite" },
			{ path: ".claude/scripts/charcount.ts", action: "noop", reason: "no upstream change" },
			{ path: ".claude/scripts/lib/charcount.ts", action: "noop", reason: "identical" },
			{ path: "templates/Work Note.md", action: "auto_merge" },
			{ path: ".claude/settings.json", action: "conflict" },
			{ path: ".claude/scripts/new-hook.ts", action: "add" },
			{ path: "brain/Gotchas.md", action: "restore_missing" },
			{ path: "old/removed.md", action: "delete" },
			{ path: "Home.md", action: "skip_volatile" },
			{ path: "mine.md", action: "keep_as_user" },
		],
	};
	const status = { installed: true, files: { modified: [{ path: ".claude/scripts/charcount.ts" }] } };

	test("each action lands where it belongs", () => {
		const r = classifyUpdate(plan, status);
		assert.deepEqual(r.behind, ["CHANGELOG.md", "vault-manifest.json", "brain/Gotchas.md", "old/removed.md"]);
		assert.deepEqual(r.ahead, [".claude/scripts/charcount.ts"]);
		assert.deepEqual(r.merged, ["templates/Work Note.md"]);
		assert.deepEqual(r.conflicts, [".claude/settings.json"]);
		assert.deepEqual(r.added, [".claude/scripts/new-hook.ts"]);
		assert.equal(r.unchanged, 3);
	});

	test("a noop on a file the user did not modify is not 'ahead'", () => {
		const r = classifyUpdate(plan, { installed: true, files: { modified: [] } });
		assert.deepEqual(r.ahead, []);
	});

	test("modified may be listed as plain paths too", () => {
		const r = classifyUpdate(plan, { installed: true, files: { modified: [".claude/scripts/charcount.ts"] } });
		assert.deepEqual(r.ahead, [".claude/scripts/charcount.ts"]);
	});
});

describe("classifyAdopt — a vault cloned without ShardMind", () => {
	const base: Record<string, string> = {
		"CHANGELOG.md": "h-old-changelog",
		".claude/scripts/charcount.ts": "h-charcount",
		".claude/settings.json": "h-old-settings",
	};
	const plan: AdoptPlan = {
		dryRun: true,
		files: [
			{ path: "Home.md", classification: "matches", shardHash: "h-home", volatile: false },
			// Template changed it, the user never did → behind.
			{ path: "CHANGELOG.md", classification: "differs", shardHash: "h-new-changelog", userHash: "h-old-changelog", volatile: false },
			// The user changed it, the template did not → ahead.
			{ path: ".claude/scripts/charcount.ts", classification: "differs", shardHash: "h-charcount", userHash: "h-mine", volatile: false },
			// Both changed it → a person decides.
			{ path: ".claude/settings.json", classification: "differs", shardHash: "h-new-settings", userHash: "h-my-settings", volatile: false },
			// The template adds a path the user already has → a person decides.
			{ path: "brain/New.md", classification: "differs", shardHash: "h-new", userHash: "h-users", volatile: false },
			{ path: "bases/New.base", classification: "shard-only", shardHash: "h-b", volatile: false },
			{ path: "brain/North Star.md", classification: "differs", shardHash: "h-x", userHash: "h-y", volatile: true },
		],
	};
	const r = classifyAdopt(plan, (p) => base[p] ?? null);

	test("behind: the user's bytes are the release they cloned", () => {
		assert.deepEqual(r.behind, ["CHANGELOG.md"]);
	});
	test("ahead: changed only locally", () => {
		assert.deepEqual(r.ahead, [".claude/scripts/charcount.ts"]);
	});
	test("conflicts: changed on both sides, or a new template path the user already has", () => {
		assert.deepEqual(r.conflicts, [".claude/settings.json", "brain/New.md"]);
	});
	test("new template files are added; matches and volatile files need no judgment", () => {
		assert.deepEqual(r.added, ["bases/New.base"]);
		assert.equal(r.unchanged, 2);
	});
	test("a renamed file is judged by its base at the old path", () => {
		const moved = classifyAdopt(
			{ dryRun: true, files: [{ path: "new/Place.md", movedFrom: "old/Place.md", classification: "differs", shardHash: "h2", userHash: "h1", volatile: false }] },
			(p) => (p === "old/Place.md" ? "h1" : null),
		);
		assert.deepEqual(moved.behind, ["new/Place.md"]);
	});
});

describe("a CLAUDE.md left in the vault (#321)", () => {
	// AGENTS.md is the one instruction file from the release that retires
	// CLAUDE.md. A CLAUDE.md the user edited survives the update, and Claude
	// Code then reads it and skips AGENTS.md, so the plan names it as a move:
	// never as "ahead" (keep it) or as a conflict to merge.
	const present = (paths: readonly string[]) => (p: string) => paths.includes(p);

	test("managed: a CLAUDE.md the user changed is a move, not a conflict", () => {
		const plan: UpdatePlan = {
			dryRun: true,
			files: [
				{ path: "CLAUDE.md", action: "conflict" },
				{ path: "AGENTS.md", action: "overwrite" },
			],
		};
		const r = withRetiredInstructionFiles(classifyUpdate(plan, null), present(["CLAUDE.md", "AGENTS.md"]));
		assert.deepEqual(r.move, ["CLAUDE.md"]);
		assert.deepEqual(r.conflicts, []);
		assert.deepEqual(r.behind, ["AGENTS.md"]);
	});

	test("managed: a modified CLAUDE.md the template no longer touches is a move, not 'ahead'", () => {
		const plan: UpdatePlan = { dryRun: true, files: [{ path: "CLAUDE.md", action: "noop" }] };
		const status = { installed: true, files: { modified: ["CLAUDE.md"] } };
		const r = withRetiredInstructionFiles(classifyUpdate(plan, status), present(["CLAUDE.md"]));
		assert.deepEqual(r.move, ["CLAUDE.md"]);
		assert.deepEqual(r.ahead, []);
		assert.equal(r.unchanged, 0);
	});

	test("managed: an untouched CLAUDE.md the update deletes is behind, not a move", () => {
		const plan: UpdatePlan = { dryRun: true, files: [{ path: "CLAUDE.md", action: "delete" }] };
		const r = withRetiredInstructionFiles(classifyUpdate(plan, null), present(["CLAUDE.md"]));
		assert.deepEqual(r.behind, ["CLAUDE.md"]);
		assert.deepEqual(r.move, []);
	});

	test("unmanaged: adopt never lists CLAUDE.md (the release has none), so its presence alone makes it a move", () => {
		const plan: AdoptPlan = {
			dryRun: true,
			files: [{ path: "Home.md", classification: "matches", shardHash: "h", volatile: false }],
		};
		const r = withRetiredInstructionFiles(classifyAdopt(plan, () => null), present(["CLAUDE.md"]));
		assert.deepEqual(r.move, ["CLAUDE.md"]);
	});

	test("unmanaged: a CLAUDE.md byte-identical to the release the vault was cloned from is behind (delete it), not a move", () => {
		const hashes: Record<string, string> = { "CLAUDE.md": "h-template" };
		const untouched = untouchedRetiredFiles(
			(p) => hashes[p] ?? null,
			(p) => (p === "CLAUDE.md" ? "h-template" : null),
			true,
		);
		assert.deepEqual(untouched, ["CLAUDE.md"]);
		const plan: AdoptPlan = { dryRun: true, files: [] };
		const r = withRetiredInstructionFiles(
			{ ...classifyAdopt(plan, () => null), behind: untouched },
			present(["CLAUDE.md"]),
		);
		assert.deepEqual(r.behind, ["CLAUDE.md"]);
		assert.deepEqual(r.move, []);
	});

	test("unmanaged: an edited CLAUDE.md, or one the base release never had, is not untouched", () => {
		assert.deepEqual(untouchedRetiredFiles(() => "h-mine", () => "h-template", true), []);
		assert.deepEqual(untouchedRetiredFiles(() => "h-mine", () => null, true), []);
		assert.deepEqual(untouchedRetiredFiles(() => null, () => "h-template", true), []);
	});

	test("unmanaged: an untouched CLAUDE.md stays a move while the new AGENTS.md is not certain to be in place", () => {
		// The v9.1 AGENTS.md only says "read CLAUDE.md". If the user's AGENTS.md
		// is ahead or a conflict, it is not rewritten, and deleting CLAUDE.md
		// would leave every agent pointed at a missing file.
		assert.deepEqual(untouchedRetiredFiles(() => "h-template", () => "h-template", false), []);
	});

	test("the new AGENTS.md is in place when it matches the release or is behind, not when it is ahead or a conflict", () => {
		const agents = (classification: AdoptPlan["files"][number]["classification"]): AdoptPlan => ({
			dryRun: true,
			files: [{ path: "AGENTS.md", classification, shardHash: "h", volatile: false }],
		});
		const report = (behind: string[]) => ({ behind, ahead: [], merged: [], conflicts: [], added: [], move: [], unchanged: 0 });
		assert.equal(instructionFilesReady(agents("matches"), report([])), true);
		assert.equal(instructionFilesReady(agents("differs"), report(["AGENTS.md"])), true);
		assert.equal(instructionFilesReady(agents("differs"), report([])), false);
	});

	test("a retired file is not deleted while .gemini/settings.json is still the user's old one", () => {
		// The old settings name no context file, so Gemini reads GEMINI.md, and
		// the old GEMINI.md only says "read CLAUDE.md".
		const plan = (settings: AdoptPlan["files"][number]["classification"]): AdoptPlan => ({
			dryRun: true,
			files: [
				{ path: "AGENTS.md", classification: "matches", shardHash: "h", volatile: false },
				{ path: ".gemini/settings.json", classification: settings, shardHash: "s", volatile: false },
			],
		});
		const report = (behind: string[]) => ({ behind, ahead: [], merged: [], conflicts: [], added: [], move: [], unchanged: 0 });
		assert.equal(instructionFilesReady(plan("matches"), report([])), true);
		assert.equal(instructionFilesReady(plan("differs"), report([".gemini/settings.json"])), true);
		assert.equal(instructionFilesReady(plan("differs"), report([])), false);
		// A vault without the Gemini module has no settings file to wait for.
		assert.equal(instructionFilesReady({ dryRun: true, files: [plan("matches").files[0]!] }, report([])), true);
	});

	test("managed: a GEMINI.md the user edited, which ShardMind keeps as theirs, is a move, not 'unchanged'", () => {
		// Gemini now reads AGENTS.md through .gemini/settings.json, so an edited
		// GEMINI.md is no longer loaded: its additions would vanish silently.
		const plan: UpdatePlan = { dryRun: true, files: [{ path: "GEMINI.md", action: "keep_as_user" }] };
		const r = withRetiredInstructionFiles(classifyUpdate(plan, null), present(["GEMINI.md"]));
		assert.deepEqual(r.move, ["GEMINI.md"]);
		assert.equal(r.unchanged, 0);
	});

	test("unmanaged: a GEMINI.md still byte-identical to the base release is behind, like CLAUDE.md", () => {
		const untouched = untouchedRetiredFiles(() => "h-template", (p) => (p === "GEMINI.md" ? "h-template" : null), true);
		assert.deepEqual(untouched, ["GEMINI.md"]);
	});

	test("a CLAUDE.md the update deletes stays behind, whatever AGENTS.md is: the report says what the update does", () => {
		// ShardMind deletes an untouched CLAUDE.md on update regardless of this
		// report, so listing it anywhere but Behind would hide a deletion.
		for (const where of ["ahead", "conflicts"] as const) {
			const base = { behind: ["CLAUDE.md"], ahead: [], merged: [], conflicts: [], added: [], move: [], unchanged: 0 };
			const r = withRetiredInstructionFiles({ ...base, [where]: ["AGENTS.md"] }, present(["CLAUDE.md", "AGENTS.md"]));
			assert.deepEqual(r.behind, ["CLAUDE.md"], where);
			assert.deepEqual(r.move, [], where);
		}
	});

	test("while AGENTS.md is a conflict and CLAUDE.md is retiring, the report says to settle AGENTS.md first", () => {
		// The vault's AGENTS.md may be the old one that only says "read
		// CLAUDE.md": once CLAUDE.md is gone, every agent is left with nothing.
		const empty = { behind: [], ahead: [], merged: [], conflicts: [], added: [], move: [], unchanged: 0 };
		for (const report of [
			{ ...empty, behind: ["CLAUDE.md"], conflicts: ["AGENTS.md"] },
			{ ...empty, move: ["CLAUDE.md"], conflicts: ["AGENTS.md"] },
		]) {
			assert.deepEqual(settleFirst(report), ["AGENTS.md"]);
			const out = formatUpgradeReport(report, "v9.1.0", "v10.0.0");
			assert.match(out, /### Settle these first/);
			assert.match(out, /`AGENTS\.md`[^\n]*only points at CLAUDE\.md/);
			// First, before any section that acts on CLAUDE.md.
			assert.ok(out.indexOf("Settle these first") < out.indexOf("- `CLAUDE.md`"));
		}
		assert.doesNotMatch(formatUpgradeReport({ ...empty, behind: ["CLAUDE.md"] }, "v9.1.0", "v10.0.0"), /Settle these first/);
		assert.doesNotMatch(formatUpgradeReport({ ...empty, conflicts: ["AGENTS.md"] }, "v9.1.0", "v10.0.0"), /Settle these first/);
	});

	test("while .gemini/settings.json is a conflict and a retired file is leaving, the report says to settle it first", () => {
		// The user's old settings name no context file, so Gemini keeps reading
		// GEMINI.md, which only points at CLAUDE.md.
		const empty = { behind: [], ahead: [], merged: [], conflicts: [], added: [], move: [], unchanged: 0 };
		for (const leaving of [{ behind: ["CLAUDE.md"] }, { move: ["GEMINI.md"] }]) {
			const report = { ...empty, ...leaving, conflicts: [".gemini/settings.json"] };
			assert.deepEqual(settleFirst(report), [".gemini/settings.json"]);
			assert.match(formatUpgradeReport(report, "v9.1.0", "v10.0.0"), /`\.gemini\/settings\.json`[^\n]*context\.fileName/);
		}
		const both = { ...empty, behind: ["CLAUDE.md"], conflicts: ["AGENTS.md", ".gemini/settings.json"] };
		assert.deepEqual(settleFirst(both), ["AGENTS.md", ".gemini/settings.json"]);
	});

	test("an AGENTS.md conflict is settled first even when GEMINI.md is the only file leaving", () => {
		// The new settings send Gemini to AGENTS.md: if that is still the old
		// pointer to a CLAUDE.md that is gone, Gemini reads nothing.
		const empty = { behind: [], ahead: [], merged: [], conflicts: [], added: [], move: [], unchanged: 0 };
		const report = { ...empty, move: ["GEMINI.md"], conflicts: ["AGENTS.md", ".gemini/settings.json"] };
		assert.deepEqual(settleFirst(report), ["AGENTS.md", ".gemini/settings.json"]);
	});

	test("an ahead AGENTS.md is the user's edit of the current release, never the old pointer: no settle warning", () => {
		// Ahead means the template did not change AGENTS.md between the two
		// releases, and the release that retires CLAUDE.md does change it.
		const empty = { behind: [], ahead: [], merged: [], conflicts: [], added: [], move: [], unchanged: 0 };
		const report = { ...empty, move: ["CLAUDE.md"], ahead: ["AGENTS.md"] };
		assert.deepEqual(settleFirst(report), []);
		assert.doesNotMatch(formatUpgradeReport(report, "v10.0.0", "v10.1.0"), /Settle these first/);
	});

	test("the Move out text names what each retired file does wrong", () => {
		const out = formatUpgradeReport(
			{ behind: [], ahead: [], merged: [], conflicts: [], added: [], move: ["CLAUDE.md", "GEMINI.md"], unchanged: 0 },
			"v9.1.0",
			"v10.0.0",
		);
		assert.match(out, /Gemini no longer reads GEMINI\.md/);
	});

	test("the Move out text covers an untouched CLAUDE.md and an AGENTS.md that is not the new one yet", () => {
		const out = formatUpgradeReport(
			{ behind: [], ahead: [], merged: [], conflicts: [], added: [], move: ["CLAUDE.md"], unchanged: 0 },
			"v9.1.0",
			"v10.0.0",
		);
		assert.match(out, /If you never edited it, just delete it/);
		assert.match(out, /Settle the files this report lists first, if any/);
	});

	test("no CLAUDE.md in the vault: nothing to move", () => {
		const r = withRetiredInstructionFiles(classifyUpdate({ dryRun: true, files: [] }, null), present([]));
		assert.deepEqual(r.move, []);
	});

	test("the report says what to do, and that nothing is merged automatically", () => {
		const out = formatUpgradeReport(
			{ behind: [], ahead: [], merged: [], conflicts: [], added: [], move: ["CLAUDE.md"], unchanged: 0 },
			"v9.1.0",
			"v10.0.0",
		);
		assert.match(out, /### Move out — retired instruction file \(1\)[\s\S]*- `CLAUDE\.md`/);
		assert.match(out, /Claude Code reads CLAUDE\.md and skips AGENTS\.md/);
		assert.match(out, /\.claude\/rules\/local\.md/);
		assert.match(out, /Nothing is merged automatically/);
	});
});

describe("formatUpgradeReport", () => {
	test("names every file in full, by section, and skips empty sections", () => {
		const out = formatUpgradeReport(
			{ behind: ["a.md"], ahead: ["b.ts"], merged: [], conflicts: [], added: [], move: [], unchanged: 7 },
			"v9.0.0",
			"v9.0.1",
		);
		assert.match(out, /^## Upgrade plan: v9\.0\.0 → v9\.0\.1\n7 file\(s\) need no judgment\./);
		assert.match(out, /### Behind \(1\)[\s\S]*- `a\.md`/);
		assert.match(out, /### Ahead — keep, and consider upstreaming \(1\)[\s\S]*- `b\.ts`/);
		assert.doesNotMatch(out, /Merged|Conflicts|New in the template|Move out/);
	});
});
