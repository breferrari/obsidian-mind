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
import { statSync, writeFileSync } from "node:fs";
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
function spawnDetachedWorker(workerPath: string, logPrefix: string): void {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", workerPath],
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
}): void {
	const mtime = readSentinelMtime(opts.sentinelPath);
	if (isDebounced(mtime, Date.now(), opts.debounceMs)) {
		debug(`${opts.logPrefix}: debounced`);
		return;
	}
	if (resolveQmdEntry() === null) {
		debug(`${opts.logPrefix}: qmd not resolvable; skipping`);
		return;
	}
	touchSentinel(opts.sentinelPath);
	spawnDetachedWorker(opts.workerPath, opts.logPrefix);
}
