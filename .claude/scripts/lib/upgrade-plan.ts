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
	/** Nothing to judge: identical, volatile, or the user's own by design. */
	readonly unchanged: number;
};

const empty = (): { -readonly [K in keyof UpgradeReport]: K extends "unchanged" ? number : string[] } => ({
	behind: [],
	ahead: [],
	merged: [],
	conflicts: [],
	added: [],
	unchanged: 0,
});

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

/** The report as markdown, for the user. Every list in full: a cut list would hide a decision. */
export function formatUpgradeReport(r: UpgradeReport, from: string, to: string): string {
	const section = (title: string, what: string, paths: readonly string[]): string =>
		paths.length === 0 ? "" : `\n### ${title} (${paths.length})\n${what}\n${paths.map((p) => `- \`${p}\``).join("\n")}\n`;
	return [
		`## Upgrade plan: ${from} → ${to}`,
		`${r.unchanged} file(s) need no judgment.`,
		section("Behind", "The template changed these and you never did. Taking the new version loses nothing.", r.behind),
		section("Ahead — keep, and consider upstreaming", "Changed only in this vault. Kept as yours.", r.ahead),
		section("Merged — review", "Changed on both sides; merged without conflict.", r.merged),
		section("Conflicts — your decision", "Changed on both sides (or a new template file where you already have one).", r.conflicts),
		section("New in the template", "Added as they are.", r.added),
	]
		.filter((s) => s !== "")
		.join("\n");
}
