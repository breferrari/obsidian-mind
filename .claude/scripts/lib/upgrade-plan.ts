/**
 * The ahead/behind judgment `/om-vault-upgrade` makes on top of ShardMind
 * (#101).
 *
 * ShardMind owns the engine lifecycle: `update` moves a managed vault to a
 * new release, `adopt` brings a vault that was cloned without it under
 * management. Its bulk modes cannot tell a file the user improved from a
 * file the user simply never updated: both are "your version differs". A
 * blunt use-all-theirs downgrades every local enhancement; a blunt
 * keep-all-mine freezes every stale file at its old release, because adopt
 * then records it as user-modified and later updates leave it alone.
 *
 * These classifiers read ShardMind 0.2.0's `--dry-run --json` plans
 * (`schemaVersion` 1) and sort every file into what to take, what to keep,
 * and what needs a person. Pure: the caller runs ShardMind and, for adopt,
 * supplies the hash of each file at the release the vault was cloned from.
 */

import { CLAUDE_MD, GEMINI_SETTINGS, INSTRUCTION_FILE, RETIRED_INSTRUCTION_FILES } from "./instruction-files.ts";

/** ShardMind's `--json` envelope. */
export type ShardmindEnvelope<T> =
	| { readonly schemaVersion: number; readonly command: string; readonly ok: true; readonly result: T }
	| {
			readonly schemaVersion: number;
			readonly command: string;
			readonly ok: false;
			readonly error: { readonly code: string | null; readonly message: string; readonly hint?: string | null };
	  };

export type StatusResult = {
	readonly installed: boolean;
	readonly version?: string;
	readonly update?: { readonly kind: string; readonly current?: string; readonly latest?: string };
	readonly files?: { readonly modified?: readonly (string | { readonly path: string })[] };
};

export type UpdatePlanFile = {
	readonly path: string;
	readonly action: string;
	readonly reason?: string;
	readonly preexisting?: boolean;
	readonly binary?: boolean;
	readonly renamedFrom?: string;
};
export type UpdatePlan = {
	readonly dryRun: boolean;
	readonly upToDate?: true;
	readonly version?: string;
	readonly files: readonly UpdatePlanFile[];
};

export type AdoptPlanFile = {
	readonly path: string;
	readonly classification: "matches" | "differs" | "shard-only";
	readonly shardHash: string;
	readonly userHash?: string;
	readonly volatile: boolean;
	readonly binary?: boolean;
	readonly movedFrom?: string;
};
export type AdoptPlan = { readonly dryRun: boolean; readonly files: readonly AdoptPlanFile[] };

export type UpgradeReport = {
	/** The template moved on and the user never touched the file: take the new version. */
	readonly behind: readonly string[];
	/** Changed only locally: keep it. An upstream candidate if it is an improvement. */
	readonly ahead: readonly string[];
	/** Changed on both sides and merged cleanly: review the result. */
	readonly merged: readonly string[];
	/** Changed on both sides and not mergeable: a person decides. */
	readonly conflicts: readonly string[];
	/** New in the template. */
	readonly added: readonly string[];
	/** A retired instruction file still in the vault: the user moves their additions out, then deletes it. */
	readonly move: readonly string[];
	/** Nothing to judge: identical, volatile, or the user's own by design. */
	readonly unchanged: number;
};

const empty = (): { -readonly [K in keyof UpgradeReport]: K extends "unchanged" ? number : string[] } => ({
	behind: [],
	ahead: [],
	merged: [],
	conflicts: [],
	added: [],
	move: [],
	unchanged: 0,
});

/**
 * Retired instruction files in an unmanaged clone whose bytes are still those
 * of the release it was cloned from: the user never edited them, so they are
 * behind (the update removes them), not a move. Adopt cannot say so itself,
 * because the latest release has no such file.
 *
 * Only once the new AGENTS.md is certain to be in place (`agentsMdInPlace`:
 * the update writes it, or it already matches the release). Until then the
 * vault's AGENTS.md may be the old one, which only says "read CLAUDE.md", and
 * deleting CLAUDE.md would leave every agent pointed at a missing file.
 */
export function untouchedRetiredFiles(
	vaultHash: (path: string) => string | null,
	baseHash: (path: string) => string | null,
	agentsMdInPlace: boolean,
): string[] {
	if (!agentsMdInPlace) return [];
	return RETIRED_INSTRUCTION_FILES.filter((p) => {
		const mine = vaultHash(p);
		return mine !== null && mine === baseHash(p);
	});
}

/**
 * Whether an adopt leaves the release's instruction wiring in place: AGENTS.md
 * and, where the Gemini module is installed, .gemini/settings.json each
 * already match the release, or are behind and the update writes them. Ahead
 * or a conflict, either may stay the user's own old copy: an old AGENTS.md
 * only points at CLAUDE.md, and old settings send Gemini to GEMINI.md, which
 * does the same.
 */
export function instructionFilesReady(plan: AdoptPlan, report: UpgradeReport): boolean {
	const ready = (path: string) =>
		report.behind.includes(path) || plan.files.some((f) => f.path === path && f.classification === "matches");
	// Shard-only means the vault has no Gemini settings at all: nothing to wait for.
	const hasGemini = plan.files.some((f) => f.path === GEMINI_SETTINGS && f.classification !== "shard-only");
	return ready(INSTRUCTION_FILE) && (!hasGemini || ready(GEMINI_SETTINGS));
}

/**
 * `report` with every retired instruction file still in the vault listed
 * under `move`, unless the update removes it anyway (it is behind: the user
 * never changed it). A retired file the user edited is neither "ahead" (keep
 * it) nor a conflict to merge: Claude Code reads a CLAUDE.md in place of
 * AGENTS.md (#321), so the user moves their additions out and deletes it.
 * Adopt plans never list these paths, because the release has no such file,
 * so presence in the vault is what decides.
 */
export function withRetiredInstructionFiles(report: UpgradeReport, present: (path: string) => boolean): UpgradeReport {
	const move = RETIRED_INSTRUCTION_FILES.filter((p) => present(p) && !report.behind.includes(p));
	return { ...report, move };
}

function modifiedPaths(status: StatusResult | null): Set<string> {
	const list = status?.files?.modified ?? [];
	return new Set(list.map((m) => (typeof m === "string" ? m : m.path)));
}

/**
 * A managed vault's update plan. ShardMind already knows each file's base
 * (the release recorded in its state), so the action says it all:
 * `overwrite`, `restore_missing` and `delete` touch only files the user left
 * alone; a `noop` on a file the status report lists as modified is a local
 * change the template never made, which is the "ahead" case the bulk modes
 * cannot see.
 */
export function classifyUpdate(plan: UpdatePlan, status: StatusResult | null): UpgradeReport {
	const r = empty();
	const modified = modifiedPaths(status);
	for (const f of plan.files) {
		// Exact names: plan paths are the template's own, never re-cased.
		if (RETIRED_INSTRUCTION_FILES.includes(f.path) && f.action !== "delete") continue;
		switch (f.action) {
			case "overwrite":
			case "restore_missing":
			case "delete":
				r.behind.push(f.path);
				break;
			case "add":
				r.added.push(f.path);
				break;
			case "auto_merge":
				r.merged.push(f.path);
				break;
			case "conflict":
				r.conflicts.push(f.path);
				break;
			case "noop":
				if (modified.has(f.path)) r.ahead.push(f.path);
				else r.unchanged++;
				break;
			default:
				// skip_volatile, keep_as_user: the user's by design.
				r.unchanged++;
		}
	}
	return r;
}

/**
 * An unmanaged clone's adopt plan. Adopt compares the user's file with the
 * LATEST release only, so a differing file is either one the user changed or
 * one the template changed since the clone; the hash of the file at the
 * release the vault was cloned from (`baseHash`, null when the path did not
 * exist there) tells them apart:
 * - user's bytes equal the base → the user never touched it → behind;
 * - user changed it, template did not (base equals the latest) → ahead;
 * - both changed it, or the path is new in the template but the user
 *   already has a file there → a person decides.
 */
export function classifyAdopt(plan: AdoptPlan, baseHash: (path: string) => string | null): UpgradeReport {
	const r = empty();
	for (const f of plan.files) {
		if (f.classification === "matches") {
			r.unchanged++;
			continue;
		}
		if (f.classification === "shard-only") {
			r.added.push(f.path);
			continue;
		}
		if (f.volatile) {
			r.unchanged++;
			continue;
		}
		const base = baseHash(f.movedFrom ?? f.path);
		if (base !== null && f.userHash === base) r.behind.push(f.path);
		else if (base !== null && f.shardHash === base) r.ahead.push(f.path);
		else r.conflicts.push(f.path);
	}
	return r;
}

/**
 * Files to resolve to the release's version before the retired instruction
 * files go, in that order. Each is a conflict (both sides changed it) while a
 * retired file leaves (behind or a move); changed by the user on top of the
 * old release, it may still be the old wiring:
 * - AGENTS.md, whose old version only points at CLAUDE.md, when CLAUDE.md
 *   is leaving;
 * - .gemini/settings.json, whose old version names no context file, so
 *   Gemini reads GEMINI.md (which only points at CLAUDE.md), when either is
 *   leaving.
 * Ahead never qualifies: ahead means the template did not change the file
 * between the two releases, and the release that retires CLAUDE.md changes
 * both, so an ahead copy is the user's edit of the current one.
 */
export function settleFirst(r: UpgradeReport): string[] {
	const leaving = (p: string) => r.behind.includes(p) || r.move.includes(p);
	const out: string[] = [];
	if (r.conflicts.includes(INSTRUCTION_FILE) && leaving(CLAUDE_MD)) out.push(INSTRUCTION_FILE);
	if (r.conflicts.includes(GEMINI_SETTINGS) && RETIRED_INSTRUCTION_FILES.some(leaving)) out.push(GEMINI_SETTINGS);
	return out;
}

const SETTLE_WHY: Readonly<Record<string, string>> = {
	[INSTRUCTION_FILE]:
		"your copy may be the old one, which only points at CLAUDE.md, so once CLAUDE.md is gone every agent is left without the vault's conventions. Take the release's AGENTS.md, then re-add your own changes to it (or to `.claude/rules/local.md`).",
	[GEMINI_SETTINGS]:
		"your copy may name no context file, so Gemini keeps reading GEMINI.md, which only points at CLAUDE.md. Take the release's version, which sets `context.fileName` to AGENTS.md, then re-add your own settings.",
};

function settleSection(files: readonly string[]): string {
	if (files.length === 0) return "";
	const lines = files.map((p) => `- \`${p}\` conflicts with the release's: ${SETTLE_WHY[p]}`);
	return `\n### Settle these first\nResolve each to the release's version in the same update, before the retired instruction files go. A managed update deletes an untouched CLAUDE.md or GEMINI.md in that run; an unmanaged clone keeps them until these are settled.\n${lines.join("\n")}\n`;
}

/** The report as markdown, for the user. Every list in full: a cut list would hide a decision. */
export function formatUpgradeReport(r: UpgradeReport, from: string, to: string): string {
	const section = (title: string, what: string, paths: readonly string[]): string =>
		paths.length === 0 ? "" : `\n### ${title} (${paths.length})\n${what}\n${paths.map((p) => `- \`${p}\``).join("\n")}\n`;
	return [
		`## Upgrade plan: ${from} → ${to}`,
		`${r.unchanged} file(s) need no judgment.`,
		settleSection(settleFirst(r)),
		section("Behind", "The template changed these and you never did. Taking the new version loses nothing.", r.behind),
		section("Ahead — keep, and consider upstreaming", "Changed only in this vault. Kept as yours.", r.ahead),
		section("Merged — review", "Changed on both sides; merged without conflict.", r.merged),
		section(
			"Move out — retired instruction file",
			"Claude Code reads CLAUDE.md and skips AGENTS.md while it is here, and Gemini no longer reads GEMINI.md, so anything you added there is lost. Settle the files this report lists first, if any. Then move what you added: from GEMINI.md into `AGENTS.md`; from CLAUDE.md into `.claude/rules/local.md`, or into `AGENTS.md` if every agent needs it. Keep `AGENTS.md` under 23 KB. Then delete the file. If you never edited it, just delete it. Nothing is merged automatically.",
			r.move,
		),
		section("Conflicts — your decision", "Changed on both sides (or a new template file where you already have one).", r.conflicts),
		section("New in the template", "Added as they are.", r.added),
	]
		.filter((s) => s !== "")
		.join("\n");
}
