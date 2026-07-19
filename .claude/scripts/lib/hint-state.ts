/**
 * Once-per-session hint state — pure helpers for the classify-message
 * dedupe (Vault Improvement Backlog, 2026-07-14).
 *
 * The classifier fires the same routing hint every time a keyword recurs;
 * a long shipping session pays the WIN hint dozens of times. This module
 * keys "already fired" signal names by Claude Code's session_id in a
 * single JSON state file (`.claude/scripts/.hint-state.json`, gitignored;
 * tests route it elsewhere via the CLASSIFY_HINT_STATE env var).
 *
 * Design constraints, in order:
 *  - Fail open. A missing session_id, unreadable file, or malformed JSON
 *    must degrade to today's behavior (all hints fire), never to silence.
 *  - Single file, self-pruning. Per-session files would accumulate without
 *    bound and would put session_id into filesystem paths; a JSON key has
 *    no traversal surface. Sessions older than PRUNE_MAX_AGE_MS or beyond
 *    PRUNE_MAX_SESSIONS (most-recently-updated kept) are dropped on write.
 *  - Best-effort concurrency. Two hooks racing is last-writer-wins; the
 *    worst case is one duplicate hint, which is acceptable.
 */

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
