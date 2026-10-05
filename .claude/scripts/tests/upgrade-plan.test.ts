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

describe("formatUpgradeReport", () => {
	test("names every file in full, by section, and skips empty sections", () => {
		const out = formatUpgradeReport(
			{ behind: ["a.md"], ahead: ["b.ts"], merged: [], conflicts: [], added: [], unchanged: 7 },
			"v9.0.0",
			"v9.0.1",
		);
		assert.match(out, /^## Upgrade plan: v9\.0\.0 → v9\.0\.1\n7 file\(s\) need no judgment\./);
		assert.match(out, /### Behind \(1\)[\s\S]*- `a\.md`/);
		assert.match(out, /### Ahead — keep, and consider upstreaming \(1\)[\s\S]*- `b\.ts`/);
		assert.doesNotMatch(out, /Merged|Conflicts|New in the template/);
	});
});
