/**
 * Pure helpers for the mid-session QMD refresh flow — unit-testable
 * without touching the filesystem or spawning processes. The PostToolUse
 * hook and Stop hook share these predicates so eligibility, debouncing,
 * and spawn composition have exactly one definition.
 *
 * Paired with `.claude/scripts/qmd-refresh.ts` (the hook entry that spawns
 * the detached worker) and `.claude/scripts/qmd-refresh-run.ts` (the
 * worker that invokes qmd update + embed). All three live in the same
 * directory; platform-specific spawn shape is delegated to `lib/qmd.ts`.
 */

import { resolve as resolvePath } from "node:path";
import { buildQmdCommand } from "./qmd.ts";
import { qmdArgsWithIndex } from "./session-start.ts";

/**
 * Path segments that must never trigger a QMD refresh — writes into these
 * aren't vault content. Matched case-sensitively against the forward-slash
 * normalized path; Windows paths are normalized by the caller before this
 * check. Leading "/" on each segment prevents accidental substring matches
 * like ".github" matching under ".git".
 */
const SKIP_SEGMENTS: readonly string[] = [
	"/.git/",
	"/.obsidian/",
	"/node_modules/",
];

/**
 * Return true if a Write/Edit to `filePath` should trigger a QMD refresh.
 * Accepts `.md` files that aren't under an excluded segment. Rejects non-
 * markdown writes and writes into version control, plugin config, or
 * dependency trees. Accepts absolute or relative paths; backslashes are
 * normalized so Windows paths (`C:\\vault\\note.md`) are handled the same
 * as Unix paths.
 *
 * Over-triggering is harmless (qmd update is idempotent and silent on
 * no-op); under-triggering is the failure mode we optimize against, so
 * the filter is deliberately permissive beyond the three skip segments.
 */
export function shouldRefreshForPath(filePath: string): boolean {
	if (typeof filePath !== "string" || filePath === "") return false;
	if (!filePath.toLowerCase().endsWith(".md")) return false;
	const normalized = "/" + filePath.replaceAll("\\", "/");
	return !SKIP_SEGMENTS.some((seg) => normalized.includes(seg));
}

/**
 * Return true when a previous refresh ran recently enough that this one
 * should be skipped. `sentinelMtimeMs` is the mtime of the debounce
 * sentinel (or null when it doesn't exist yet); `nowMs` is Date.now();
 * `debounceMs` is the minimum gap between refreshes.
 *
 * Null sentinel → not debounced (first run in this session or sentinel
 * was cleared). Clock skew going backwards (nowMs < mtime) is treated as
 * "not debounced" so we don't wedge indefinitely on a bad clock — if
 * anything, that's the safer failure mode.
 */
export function isDebounced(
	sentinelMtimeMs: number | null,
	nowMs: number,
	debounceMs: number,
): boolean {
	if (sentinelMtimeMs === null) return false;
	const elapsed = nowMs - sentinelMtimeMs;
	if (elapsed < 0) return false;
	return elapsed < debounceMs;
}

/**
 * Return the absolute vault root derived from a hook script's own
 * directory. Hook scripts live at `<vault>/.claude/scripts/`, so going
 * two segments up resolves the vault root irrespective of the invoking
 * shell's cwd or whether any `*_PROJECT_DIR` env var is set.
 *
 * This anchor lets the worker read the manifest from a known-good
 * absolute path, eliminating a class of silent bug where a drifted cwd
 * caused the worker to update QMD's default global collection instead
 * of the vault's named index.
 */
export function resolveVaultRoot(scriptDirAbsolute: string): string {
	return resolvePath(scriptDirAbsolute, "..", "..");
}

/**
 * Shape returned by `lib/qmd.ts:buildQmdCommand`. Duplicated here as a
 * local alias so callers don't need to import the same tuple twice when
 * all they want is the readonly shape.
 */
export type QmdInvocation = {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly shell: boolean;
};

/**
 * Compose the (cmd, args, shell) tuples the detached worker must spawn
 * in sequence. Currently `update` (refresh BM25/FTS index) followed by
 * `embed` (refresh vector index) so both retrieval arms stay current.
 *
 * Kept pure so tests can assert the full invocation list across
 * platforms without spawning anything. Locking the list at the unit
 * level means the CI matrix catches argv drift (wrong order, missing
 * `--index`, dropped subcommand) on every OS, not just the OS where a
 * live qmd happens to be installed.
 */
export function composeWorkerInvocations(
	qmdIndex: string | null,
	entry: string | null,
): readonly QmdInvocation[] {
	return [
		buildQmdCommand(entry, qmdArgsWithIndex(qmdIndex, ["update"])),
		buildQmdCommand(entry, qmdArgsWithIndex(qmdIndex, ["embed"])),
	];
}
