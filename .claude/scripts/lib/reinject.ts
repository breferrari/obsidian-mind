/**
 * Re-injecting the session context after a Gemini compression (#357).
 *
 * Gemini CLI fires no SessionStart when it compresses a conversation: its
 * SessionStart sources are startup, resume and clear. And the compression
 * summarises the early turn that carried the session context. Interactive
 * Gemini adds SessionStart's additionalContext as an ordinary first user turn,
 * and compression sends history up to its split point to a summariser,
 * rebuilding only the environment context (gemini-cli ui/AppContainer.tsx and
 * context/chatCompressionService.ts, as of 29315e5). Claude Code and Codex
 * re-inject on SessionStart `compact` instead.
 *
 * So Gemini's PreCompress marks the session (pre-compact.ts), and the next
 * BeforeAgent (classify-message.ts) hands over session-start's compact context
 * once: the same volatile sections Claude Code gets after a compaction. The
 * marker lives beside the Stop handoffs, so the same age pruning covers it.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHookContext } from "./hook-io.ts";

/** The session's marker file. Session ids are reduced to a safe filename. */
function markerPath(dir: string, sessionId: string): string {
	return join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.reinject`);
}

/** Whether this pre-compaction hook call should schedule a re-injection: Gemini's PreCompress, with a session. */
export function schedulesReinject(input: { readonly hook_event_name?: unknown; readonly session_id?: unknown }): boolean {
	return input.hook_event_name === "PreCompress" && typeof input.session_id === "string" && input.session_id !== "";
}

/** Mark the session for a re-injection on its next prompt. Throws if it cannot. */
export function markReinject(dir: string, sessionId: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(markerPath(dir, sessionId), "");
}

/** Take the session's mark, once: true when one was waiting. */
export function takeReinject(dir: string, sessionId: string): boolean {
	try {
		unlinkSync(markerPath(dir, sessionId));
		return true;
	} catch {
		return false;
	}
}

/** Runs session-start with `stdin` as its hook input and returns its exit status and stdout. */
export type SessionStartRun = (stdin: Record<string, unknown>) => { readonly status: number | null; readonly stdout: string };

const SESSION_START = join(dirname(dirname(fileURLToPath(import.meta.url))), "session-start.ts");

/**
 * session-start.ts can't be imported: it is a hook script whose work runs at
 * the top level. So it runs as a child, once per compression, bounded, and
 * hidden on Windows (#390).
 */
export const runSessionStart: SessionStartRun = (stdin) => {
	const r = spawnSync(process.execPath, ["--experimental-strip-types", SESSION_START], {
		input: JSON.stringify(stdin),
		encoding: "utf8",
		timeout: 20_000,
		windowsHide: true,
	});
	return { status: r.status, stdout: r.stdout ?? "" };
};

/**
 * The session context to re-inject on this prompt, or null. Takes the mark
 * first, so a run that fails is not retried on every prompt after it.
 */
export function reinjectContext(dir: string, sessionId: string, run: SessionStartRun = runSessionStart): string | null {
	if (!takeReinject(dir, sessionId)) return null;
	const r = run({ hook_event_name: "SessionStart", source: "compact", session_id: sessionId });
	if (r.status !== 0) return null;
	try {
		const context = parseHookContext(r.stdout, "SessionStart");
		return context.trim() === "" ? null : context;
	} catch {
		return null;
	}
}
