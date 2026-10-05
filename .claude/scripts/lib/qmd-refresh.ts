/**
 * Mid-session QMD refresh — pure predicates, spawn composition, and the
 * shared debounced-trigger flow. Consumed by the PostToolUse hook
 * (`.claude/scripts/qmd-refresh.ts`), the Stop hook
 * (`.claude/scripts/stop-checklist.ts`), and the detached worker
 * (`.claude/scripts/qmd-refresh-run.ts`). Centralizing the lifecycle
 * here guarantees both hook entries honor the same debounce contract
 * and spawn shape — the only way to drift is to bypass this module.
 *
 * The pure helpers at the top of this file (path filter, debounce math,
 * vault-root resolver, invocation composer) run identically on Windows,
 * macOS, and Linux and are exercised in the CI matrix without side
 * effects. The impure orchestration at the bottom (sentinel + spawn)
 * delegates platform-specific spawn shape to `lib/qmd.ts`.
 */

import { spawn } from "node:child_process";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { buildQmdCommand, resolveQmdEntry } from "./qmd.ts";
import { debug } from "./hook-io.ts";
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
 * Parameter is typed `unknown` because the production caller pulls it
 * from a hook JSON payload (`tool_input.file_path` is `unknown` at the
 * type boundary), so the runtime narrowing here is the type guard for
 * downstream code — tests pass `null` / `undefined` directly to lock the
 * defensive path without needing an `as any` escape.
 *
 * Over-triggering is harmless (qmd update is idempotent and silent on
 * no-op); under-triggering is the failure mode we optimize against, so
 * the filter is deliberately permissive beyond the three skip segments.
 */
export function shouldRefreshForPath(filePath: unknown): boolean {
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
 * How long a `.pending` marker is trusted past the end of the window it was
 * written for. A marker older than that belongs to a trailing worker that
 * never ran (killed, machine slept) and must not suppress flushes forever.
 */
export const PENDING_GRACE_MS = 60_000;

export type RefreshPlan = "now" | "trailing" | "skip";

/**
 * Decide what one trigger does. The debounce bounds machine drag from a
 * burst of writes, but on its own it only fires on the LEADING edge: a note
 * written inside the window after a refresh was never indexed until some
 * unrelated trigger landed outside it, and the last write of a session
 * stayed unsearchable until the next SessionStart.
 *
 * - `now`      — outside the window: refresh immediately.
 * - `trailing` — inside the window, and no flush owed yet: schedule one for
 *                the window's end.
 * - `skip`     — inside the window, and a flush is already owed (a live
 *                pending marker): that flush will cover this write too.
 */
export function planRefresh(
	sentinelMtimeMs: number | null,
	pendingMtimeMs: number | null,
	nowMs: number,
	debounceMs: number,
): RefreshPlan {
	if (!isDebounced(sentinelMtimeMs, nowMs, debounceMs)) return "now";
	const pendingLive =
		pendingMtimeMs !== null &&
		nowMs >= pendingMtimeMs &&
		nowMs - pendingMtimeMs < debounceMs + PENDING_GRACE_MS;
	return pendingLive ? "skip" : "trailing";
}

/** The marker that records a trailing flush is owed. */
export function pendingPathFor(sentinelPath: string): string {
	return `${sentinelPath}.pending`;
}

/**
 * The trailing worker's gate, run once it has slept out the window. Clears
 * the pending marker FIRST, so a write landing during this flush schedules
 * the next one rather than being skipped. Then runs only if no refresh has
 * started since the flush was scheduled (`scheduledAfterMs` is the sentinel
 * mtime the scheduler saw): a newer refresh already covers these writes.
 * When it runs, it stamps the sentinel like any other refresh.
 */
export function claimTrailingFlush(
	sentinelPath: string,
	scheduledAfterMs: number | null,
): boolean {
	try {
		rmSync(pendingPathFor(sentinelPath), { force: true });
	} catch {
		/* a marker we cannot remove ages out via PENDING_GRACE_MS */
	}
	const current = readSentinelMtime(sentinelPath);
	if (current !== null && scheduledAfterMs !== null && current > scheduledAfterMs) {
		return false;
	}
	touchSentinel(sentinelPath);
	return true;
}

/**
 * Parse the worker's trailing-flush arguments. Absent or malformed → an
 * immediate run, exactly as before trailing flushes existed. The delay is
 * capped so a bad value cannot park a detached process for long.
 */
export function parseWorkerArgs(argv: readonly string[]): {
	readonly trailing: { readonly delayMs: number; readonly sentinelPath: string; readonly afterMs: number | null } | null;
} {
	const get = (name: string): string | null => {
		const hit = argv.find((a) => a.startsWith(`--${name}=`));
		return hit === undefined ? null : hit.slice(name.length + 3);
	};
	const sentinelPath = get("trailing");
	const delay = Number(get("delay-ms"));
	if (!sentinelPath || !Number.isFinite(delay) || delay < 0) return { trailing: null };
	const afterRaw = get("after");
	const after = afterRaw === null || afterRaw === "" ? Number.NaN : Number(afterRaw);
	return {
		trailing: {
			delayMs: Math.min(delay, 120_000),
			sentinelPath,
			afterMs: Number.isFinite(after) ? after : null,
		},
	};
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
 * A single qmd subcommand spawn — cmd, args, shell flag (from
 * `buildQmdCommand`) plus the per-step timeout budget. Pairing the
 * timeout with its invocation keeps the worker's execution loop from
 * needing a parallel positional array; reordering the pipeline can
 * never silently swap timeouts onto the wrong step.
 */
type QmdInvocation = {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly shell: boolean;
	readonly timeoutMs: number;
};

/**
 * Compose the invocation sequence the detached worker must spawn in
 * order: `update` (refresh BM25/FTS index), then `embed` (refresh
 * vector index), then a tail-chase `update` that catches files written
 * during the first two steps so they're BM25-searchable immediately
 * rather than waiting 30s+ for the next trigger. The tail update's new
 * content picks up vector coverage on the next refresh cycle.
 *
 * Per-step timeouts: `update` caps at 60s each (enough for an
 * incremental re-index on a 10k-note vault); `embed` caps at 5 minutes
 * (first run may download the embedding model on a fresh machine). All
 * three run detached — the budgets bound machine drag, not user
 * latency.
 *
 * Kept pure so tests can assert the full invocation list across
 * platforms without spawning anything. Locking argv and timeouts at the
 * unit level means the CI matrix catches drift on every OS, not just
 * the OS where a live qmd happens to be installed.
 */
export function composeWorkerInvocations(
	qmdIndex: string | null,
	entry: string | null,
): readonly QmdInvocation[] {
	const update: QmdInvocation = {
		...buildQmdCommand(entry, qmdArgsWithIndex(qmdIndex, ["update"])),
		timeoutMs: 60_000,
	};
	const embed: QmdInvocation = {
		...buildQmdCommand(entry, qmdArgsWithIndex(qmdIndex, ["embed"])),
		timeoutMs: 300_000,
	};
	return [update, embed, update];
}

// --- Impure orchestration ---------------------------------------------------

/**
 * Read the debounce sentinel's mtime, or null when it doesn't exist.
 * Any fs error (permission, race against deletion) collapses to null
 * and the caller treats it as "no prior refresh" — the worst outcome
 * is an extra worker spawn, which qmd serializes internally.
 */
function readSentinelMtime(sentinelPath: string): number | null {
	try {
		return statSync(sentinelPath).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Stamp the sentinel so subsequent triggers within `debounceMs` skip.
 * A single `writeFileSync` is one syscall on Windows and POSIX alike
 * and atomically bumps mtime — simpler than an open/futimes/close
 * dance, and the sentinel's contents are never read (only its mtime).
 */
function touchSentinel(sentinelPath: string): void {
	try {
		writeFileSync(sentinelPath, "");
	} catch (err) {
		debug(
			`qmd-refresh: sentinel write failed: ${(err as Error)?.message ?? "?"}`,
		);
	}
}

/**
 * Spawn the detached worker. `stdio: 'ignore'` + `.unref()` + `detached`
 * survive parent exit without leaving file descriptors open, and
 * `windowsHide: true` suppresses the transient console window that a
 * naked `spawn` creates on Windows. Errors are logged under HOOK_DEBUG
 * only — production is silent per the hook protocol.
 */
function spawnDetachedWorker(
	workerPath: string,
	logPrefix: string,
	workerArgs: readonly string[] = [],
): void {
	const child = spawn(
		process.execPath,
		[
			"--disable-warning=ExperimentalWarning",
			"--experimental-strip-types",
			workerPath,
			...workerArgs,
		],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			cwd: process.cwd(),
		},
	);
	child.on("error", (err) => {
		debug(`${logPrefix}: worker spawn error: ${err.message}`);
	});
	child.unref();
}

/**
 * The end-to-end refresh trigger both hook entries call: check the
 * debounce window, bail if qmd isn't resolvable, otherwise stamp the
 * sentinel and fire the detached worker. Returns immediately — every
 * path is non-blocking.
 *
 * Callers set their own `logPrefix` so HOOK_DEBUG traces distinguish
 * the PostToolUse path ("qmd-refresh") from the Stop path
 * ("stop-checklist"). Both share the same sentinel + debounce window
 * so a Stop firing seconds after a PostToolUse refresh won't spawn a
 * redundant second worker.
 */
export function triggerDebouncedRefresh(opts: {
	readonly sentinelPath: string;
	readonly workerPath: string;
	readonly debounceMs: number;
	readonly logPrefix: string;
	/** Test seams; production uses the real resolver and spawn. */
	readonly qmdAvailable?: () => boolean;
	readonly spawnWorker?: (workerPath: string, args: readonly string[]) => void;
}): void {
	const now = Date.now();
	const mtime = readSentinelMtime(opts.sentinelPath);
	const pendingPath = pendingPathFor(opts.sentinelPath);
	const plan = planRefresh(mtime, readSentinelMtime(pendingPath), now, opts.debounceMs);
	if (plan === "skip") {
		debug(`${opts.logPrefix}: debounced; trailing flush already pending`);
		return;
	}
	const available = opts.qmdAvailable ?? (() => resolveQmdEntry() !== null);
	if (!available()) {
		debug(`${opts.logPrefix}: qmd not resolvable; skipping`);
		return;
	}
	const spawnWorker =
		opts.spawnWorker ??
		((path: string, args: readonly string[]) => spawnDetachedWorker(path, opts.logPrefix, args));

	if (plan === "now") {
		touchSentinel(opts.sentinelPath);
		spawnWorker(opts.workerPath, []);
		return;
	}

	// Trailing: owe exactly one flush for this window. `wx` makes the claim
	// exclusive, so two hooks racing inside the window spawn one worker.
	try {
		writeFileSync(pendingPath, "", { flag: "wx" });
	} catch {
		// The marker exists. A live one means another hook won the race and
		// its worker covers this write; a stale one is reclaimed.
		if (planRefresh(mtime, readSentinelMtime(pendingPath), now, opts.debounceMs) === "skip") return;
		try {
			writeFileSync(pendingPath, "");
		} catch {
			return;
		}
	}
	const remaining = Math.max(0, (mtime ?? now) + opts.debounceMs - now);
	debug(`${opts.logPrefix}: debounced; trailing flush in ${remaining}ms`);
	spawnWorker(opts.workerPath, [
		`--trailing=${opts.sentinelPath}`,
		`--delay-ms=${remaining}`,
		`--after=${mtime ?? ""}`,
	]);
}
