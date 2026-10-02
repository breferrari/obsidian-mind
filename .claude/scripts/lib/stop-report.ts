/**
 * The Stop report in two forms: a short summary for the user and the full
 * report for the agent. Why two, and how the full one travels: lib/stop-handoff.ts.
 */

/** What both framings close with, so the two cannot drift apart on it. */
const STANDING_RULES = "Never move or delete notes without asking, and do not recite the report back.";

/** Framing for the agent, which reads the report alongside the user's next message. */
export const AGENT_PREFACE = `Stop hook report, handed over with this message: when your previous response ended, these findings were new or changed since the last report this session. The user saw only a one-line summary of each section. Deal with the user's message first, then decide what the report calls for: act on what bears on the current work, ask the user when something needs their call, or leave it unmentioned if nothing needs doing. ${STANDING_RULES}`;

/** The closing line of the summary: where the detail went. */
export const SUMMARY_TRAILER = "The full report reaches the agent with your next message.";

/**
 * The same pair for the fallback, when the report could not be saved and goes
 * out now as Stop feedback: the agent gets it at once, in a turn with no user
 * message, and Claude Code prints it in full for the user too.
 */
export const FEEDBACK_PREFACE = `Stop hook report: your response just ended, and these findings are new or changed since the last report this session; the user is shown this report too. Decide what it calls for: act on what bears on the current work, ask the user when something needs their call, or reply in one line that nothing needs doing now. ${STANDING_RULES}`;
export const FEEDBACK_TRAILER = "The full report went to the agent now, as Stop hook feedback.";

/**
 * The user's copy: the checklist reduced to one line, one line naming each
 * hygiene finding by its claim (`hygieneClaims` in lib/active-hygiene.ts: no
 * file lists, no instructions), and where the full report went (`trailer`).
 */
export function stopSummary(checklistLine: string, claims: readonly string[], trailer: string = SUMMARY_TRAILER): string {
	const lines = [checklistLine];
	if (claims.length > 0) lines.push(`Hygiene: ${claims.join(" · ")}`);
	lines.push(trailer);
	return lines.join("\n");
}
