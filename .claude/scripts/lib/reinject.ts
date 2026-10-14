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
 * BeforeAgent (classify-message.ts) hands over session-start's full context
 * once. Full, not compact: Claude Code's compact form points at sections it
 * keeps in the conversation, but Gemini's compression summarised those away.
 * A resume or clear first takes the mark (session-start.ts), since it injects
 * the context itself. The mark lives beside the Stop handoffs, and marking
 * prunes old ones, since Gemini's checklist never does.
 *
 * Not covered (inferred from gemini-cli's flow, not observed): a PreCompress
 * whose compression then does nothing still marks the session, so the next
 * prompt gets the context again; and a compression partway through a long
 * turn gets the context back only on the next prompt.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHookContext } from "./hook-io.ts";
import { REFRESH_SWITCH } from "./qmd.ts";
import { pruneHandoffs, sessionFile } from "./stop-handoff.ts";

/** The session's marker file. */
const markerPath = (dir: string, sessionId: string): string => sessionFile(dir, sessionId, "reinject");

/** Whether this pre-compaction hook call should schedule a re-injection: Gemini's PreCompress, with a session. */
export function schedulesReinject(input: { readonly hook_event_name?: unknown; readonly session_id?: unknown }): boolean {
	return input.hook_event_name === "PreCompress" && typeof input.session_id === "string" && input.session_id !== "";
}

/**
 * Mark the session for a re-injection on its next prompt. Throws if it cannot.
 * Prunes old handoffs and marks first: Gemini runs its checklist on SessionEnd,
 * which never prunes, so a session that ends right after compressing would
 * otherwise leave its mark behind for good.
 */
export function markReinject(dir: string, sessionId: string): void {
	mkdirSync(dir, { recursive: true });
	pruneHandoffs(dir, Date.now());
	writeFileSync(markerPath(dir, sessionId), "");
}

/**
 * Take the session's mark, once: true when one was waiting. Claimed by rename
 * first, as the handoff is, so two hooks racing for one mark can't both run
 * session-start.
 */
export function takeReinject(dir: string, sessionId: string): boolean {
	const target = markerPath(dir, sessionId);
	const claimed = `${target}.${process.pid}.claimed`;
	try {
		renameSync(target, claimed);
	} catch {
		return false;
	}
	try {
		unlinkSync(claimed);
	} catch {
		/* best effort: pruning removes it later */
	}
	return true;
}

/** Runs session-start with `stdin` as its hook input and returns its exit status and stdout. */
export type SessionStartRun = (stdin: Record<string, unknown>) => { readonly status: number | null; readonly stdout: string };

const SESSION_START = join(dirname(dirname(fileURLToPath(import.meta.url))), "session-start.ts");

/**
 * session-start.ts can't be imported: it is a hook script whose work runs at
 * the top level. So it runs as a child, once per compression, hidden on
 * Windows (#390), and bounded under Gemini's 15 s BeforeAgent budget so the
 * hook still answers if the child is slow. The refresh is off in the child:
 * PreCompress already started one.
 */
export const runSessionStart: SessionStartRun = (stdin) => {
	const r = spawnSync(process.execPath, ["--experimental-strip-types", SESSION_START], {
		input: JSON.stringify(stdin),
		encoding: "utf8",
		timeout: 10_000,
		windowsHide: true,
		env: { ...process.env, [REFRESH_SWITCH]: "off" },
	});
	return { status: r.status, stdout: r.stdout ?? "" };
};

/**
 * The session context to re-inject on this prompt, or null. Takes the mark
 * first, so a run that fails is not retried on every prompt after it.
 */
export function reinjectContext(dir: string, sessionId: string, run: SessionStartRun = runSessionStart): string | null {
	if (!takeReinject(dir, sessionId)) return null;
	const r = run({ hook_event_name: "SessionStart", source: "startup", session_id: sessionId });
	if (r.status !== 0) return null;
	try {
		const context = parseHookContext(r.stdout, "SessionStart");
		return context.trim() === "" ? null : context;
	} catch {
		return null;
	}
}
