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
 * So Gemini's PreCompress builds session-start's full context and stores it
 * for the session (pre-compact.ts, with lib/session-start-run.ts), and the
 * next BeforeAgent (classify-message.ts) hands it over once: a file read on
 * the prompt path, not a session-start run. Full, not compact: Claude Code's
 * compact form points at sections it keeps in the conversation, but Gemini's
 * compression summarised those away. A resume or clear first takes the stored
 * context and injects the full form itself (session-start.ts). It lives beside
 * the Stop handoffs, and storing prunes old ones, since Gemini's checklist
 * never does.
 *
 * Not covered (inferred from gemini-cli's flow, not observed): a PreCompress
 * whose compression then does nothing still stores the context, so the next
 * prompt gets it again; a compression partway through a long turn gets the
 * context back only on the next prompt; and a resume after that prompt gets
 * the compact form, whether or not Gemini's saved history kept the
 * re-injected context (TBC). And the re-injected context leaves out the qmd
 * self-heal and version warnings: its build skips the qmd work, so a warning
 * given at startup is lost with the compressed turn.
 */

import { claimSessionFile, pruneHandoffs, writeSessionFile } from "./stop-handoff.ts";

const EXTENSION = "reinject";

/** The session to re-inject for, from a pre-compaction hook call: Gemini's PreCompress with a session, else null. */
export function reinjectSession(input: { readonly hook_event_name?: unknown; readonly session_id?: unknown }): string | null {
	return input.hook_event_name === "PreCompress" && typeof input.session_id === "string" && input.session_id !== ""
		? input.session_id
		: null;
}

/**
 * Store `context` for the session's next prompt, stamped with when it was
 * built: the prompt can come hours later, and the dated sections are as of
 * then. A null or empty context stores nothing. Throws if it cannot write.
 * Prunes old handoffs whatever the context: Gemini runs its checklist on
 * SessionEnd, which never prunes, so this is the one prune Gemini's handoffs
 * get.
 */
export function storeReinject(dir: string, sessionId: string, context: string | null, now: Date = new Date()): void {
	pruneHandoffs(dir, now.getTime());
	if (context === null || context.trim() === "") return;
	const stamp = `(Session context rebuilt ${localTime(now)}, when the conversation was about to be compressed.)`;
	writeSessionFile(dir, sessionId, EXTENSION, `${stamp}\n\n${context}`);
}

/** `YYYY-MM-DD HH:MM` in local time, the clock the context's Date section uses. */
function localTime(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Take the session's stored context, once: null when none is waiting, or it is empty. */
export function takeReinject(dir: string, sessionId: string): string | null {
	const context = claimSessionFile(dir, sessionId, EXTENSION);
	return context?.trim() ? context : null;
}
