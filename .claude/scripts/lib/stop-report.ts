/**
 * The Stop report in two forms: a short summary for the user and the full
 * report for the agent.
 *
 * Every Stop output that reaches the model is also printed in full for the
 * user: a `decision: "block"` reason under a "Stop hook error" label, and Stop
 * `additionalContext` under "Stop hook feedback". So on a changed Stop the
 * user sees `stopSummary` (one line per section, as the `systemMessage`), and
 * the full report is saved for the session's next prompt, where
 * UserPromptSubmit hands it to the agent (lib/stop-handoff.ts). UserPromptSubmit
 * context is the one channel the agent reads and the user never sees.
 */

/** Framing for the agent, which reads the report alongside the user's next message. */
export const AGENT_PREFACE =
	"Stop hook report, handed over with this message: when your previous response ended, these findings were new or changed since the last report this session. The user saw only a one-line summary of each section. Deal with the user's message first, then decide what the report calls for: act on what bears on the current work, ask the user when something needs their call, or leave it unmentioned if nothing needs doing. Never move or delete notes without asking, and do not recite the report back.";

/** The closing line of the summary: where the detail went. */
export const SUMMARY_TRAILER = "The full report reaches the agent with your next message.";

/**
 * The same pair for the fallback, when the report could not be saved and goes
 * out now as Stop feedback: the agent gets it at once, in a turn with no user
 * message, and Claude Code prints it in full for the user too.
 */
export const FEEDBACK_PREFACE =
	"Stop hook report: your response just ended, and these findings are new or changed since the last report this session; the user is shown this report too. Decide what it calls for: act on what bears on the current work, ask the user when something needs their call, or reply in one line that nothing needs doing now. Never move or delete notes without asking, and do not recite the report back.";
export const FEEDBACK_TRAILER = "The full report went to the agent now, as Stop hook feedback.";

/** A finding's first line opens with ⚠️ at the margin; its detail lines are indented. */
const MARKER = /^⚠️\s*/u;

/**
 * "5 notes past the threshold — SPLIT it (…):" → "5 notes past the threshold",
 * keeping "(s)" plurals. The claim ends at the first dash or sentence end,
 * whichever comes first: the memory-inbox finding's first sentence is the
 * claim and the rest is instructions for the agent.
 */
function headline(line: string): string {
	const claim = line.replace(MARKER, "").split(/ — |\. /)[0] ?? "";
	return claim.replace(/ \([^)]*\)/g, "").replace(/[:.]$/, "").trim();
}

/**
 * The user's copy: the checklist reduced to one line, one line naming each
 * hygiene finding by its claim (no file lists, no instructions), and where the
 * full report went (`trailer`).
 */
export function stopSummary(checklistLine: string, hygieneLines: readonly string[], trailer: string = SUMMARY_TRAILER): string {
	const lines = [checklistLine];
	const findings = hygieneLines.filter((l) => MARKER.test(l)).map(headline);
	if (findings.length > 0) lines.push(`Hygiene: ${findings.join(" · ")}`);
	lines.push(trailer);
	return lines.join("\n");
}
