/**
 * Per-session hook state — what a session has already been shown, so a hook
 * that fires every turn does not repeat itself (Vault Improvement Backlog,
 * 2026-07-14; #252).
 *
 * Two hooks use it, each with its own gitignored JSON state file:
 *  - classify-message fires the same routing hint every time a keyword
 *    recurs; a long shipping session paid the WIN hint dozens of times.
 *    `claimUnseen` keeps a set per session: each hint fires once.
 *    (`.claude/scripts/.hint-state.json`; tests set CLASSIFY_HINT_STATE.)
 *  - stop-checklist runs after every response. `claimChanged` keeps the
 *    last report per session: it shows again only when the report differs
 *    from the last one shown, so drift that is fixed and then comes back is
 *    reported again. (`.claude/scripts/.checklist-state.json`; tests set
 *    STOP_CHECKLIST_STATE.)
 *
 * Design constraints, in order:
 *  - Fail open. A missing session_id, unreadable file, or malformed JSON
 *    must degrade to showing everything, never to silence.
 *  - Single file, self-pruning. Per-session files would accumulate without
 *    bound and would put session_id into filesystem paths; a JSON key has
 *    no traversal surface. Sessions older than PRUNE_MAX_AGE_MS or beyond
 *    PRUNE_MAX_SESSIONS (most-recently-updated kept) are dropped on write.
 *  - Best-effort concurrency. Two hooks racing is last-writer-wins; the
 *    worst case is one duplicate hint, which is acceptable.
 */

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import { debug } from "./hook-io.ts";

export type HintSessionEntry = {
	readonly seen: readonly string[];
	readonly updated: string; // ISO timestamp of last write
};

export type HintState = Readonly<Record<string, HintSessionEntry>>;

export const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PRUNE_MAX_SESSIONS = 200;

/**
 * Parse the state file's raw contents. Anything that isn't a well-formed
 * state object — null input, malformed JSON, wrong shapes — degrades to
 * an empty state (fail open). Individually malformed session entries are
 * dropped rather than poisoning the whole file.
 */
export function parseHintState(raw: string | null): HintState {
	if (raw === null) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const out: Record<string, HintSessionEntry> = {};
	for (const [sessionId, entry] of Object.entries(parsed)) {
		if (entry === null || typeof entry !== "object") continue;
		const seen = (entry as Record<string, unknown>)["seen"];
		const updated = (entry as Record<string, unknown>)["updated"];
		if (!Array.isArray(seen) || typeof updated !== "string") continue;
		out[sessionId] = {
			seen: seen.filter((s): s is string => typeof s === "string"),
			updated,
		};
	}
	return out;
}

/** Signal names that have NOT yet fired for this session. */
export function unseen(
	state: HintState,
	sessionId: string,
	names: readonly string[],
): string[] {
	const seen = new Set(state[sessionId]?.seen ?? []);
	return names.filter((n) => !seen.has(n));
}

/** New state with `names` merged into the session's seen set. */
export function record(
	state: HintState,
	sessionId: string,
	names: readonly string[],
	nowIso: string,
): HintState {
	const seen = new Set(state[sessionId]?.seen ?? []);
	for (const n of names) seen.add(n);
	return {
		...state,
		[sessionId]: { seen: [...seen].sort(), updated: nowIso },
	};
}

/**
 * Drop sessions older than `maxAgeMs` (by their `updated` stamp; entries
 * with unparseable stamps are treated as expired) and cap the total at
 * `maxSessions`, keeping the most recently updated.
 */
export function prune(
	state: HintState,
	nowMs: number,
	maxAgeMs: number = PRUNE_MAX_AGE_MS,
	maxSessions: number = PRUNE_MAX_SESSIONS,
): HintState {
	const fresh = Object.entries(state).filter(([, entry]) => {
		const t = Date.parse(entry.updated);
		return Number.isFinite(t) && nowMs - t <= maxAgeMs;
	});
	fresh.sort(
		([, a], [, b]) => Date.parse(b.updated) - Date.parse(a.updated),
	);
	return Object.fromEntries(fresh.slice(0, maxSessions));
}

/** The state file's contents, or empty when missing or unreadable (fail open). */
function loadHintState(path: string): HintState {
	try {
		return parseHintState(readFileSync(path, { encoding: "utf-8" }));
	} catch {
		return {};
	}
}

/**
 * Prune and write the state, through a temp file and a rename, so a hook
 * killed mid-write leaves the previous state rather than truncated JSON that
 * would read back as empty for every session. Best-effort: a failed write
 * must never block a hook, and the caller then fails open (shows again).
 */
function saveHintState(path: string, state: HintState, now: Date): void {
	try {
		writeFileAtomic(path, JSON.stringify(prune(state, now.getTime())));
	} catch (err) {
		debug(`hint-state: could not write ${path} (${(err as Error).message}); the next run fails open`);
	}
}

/**
 * The names this session has not seen yet, now recorded as seen. Each name
 * is returned once per session; a missing or unreadable state file returns
 * them all.
 */
export function claimUnseen(
	path: string,
	sessionId: string,
	names: readonly string[],
	now: Date = new Date(),
): string[] {
	const state = loadHintState(path);
	const fresh = unseen(state, sessionId, names);
	if (fresh.length > 0) {
		saveHintState(path, record(state, sessionId, fresh, now.toISOString()), now);
	}
	return fresh;
}

/**
 * Whether `value` differs from the last value recorded for this session,
 * recording it when it does. Unlike `claimUnseen`, only the latest value is
 * kept, so a value that returns after a different one counts as changed
 * (A → B → A shows A again). A missing or unreadable state file counts as
 * changed.
 */
export function claimChanged(
	path: string,
	sessionId: string,
	value: string,
	now: Date = new Date(),
): boolean {
	// Same entry shape as claimUnseen, used as a one-slot record: `seen` holds
	// only the latest value, so the shared parse and prune apply unchanged.
	// A repeat is recorded too, refreshing `updated`: pruning goes by that
	// stamp, and a long session whose report never changed must not age out
	// and be shown again as if new.
	const state = loadHintState(path);
	const last = state[sessionId]?.seen;
	const changed = !(last?.length === 1 && last[0] === value);
	const entry = { seen: [value], updated: now.toISOString() };
	saveHintState(path, { ...state, [sessionId]: entry }, now);
	return changed;
}
