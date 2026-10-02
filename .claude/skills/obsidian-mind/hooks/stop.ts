import type { PromptOrigin } from 'claude-code'

/**
 * The Stop report as the mod receives it from `stop-checklist.ts` run with
 * `om_mod: "report"` (#264), and how it is shown (#266).
 */
export type StopReport = {
	/** The report's identity: the same findings give the same key. */
	readonly key: string
	/** One short claim per finding, e.g. "1 note(s) marked done but still in active/". */
	readonly claims: readonly string[]
	/** The full report, prefaced for the agent. */
	readonly agentText: string
	/**
	 * Set only for a finding that should not wait for the person's next
	 * message. The template's report has no such class today; a vault that adds
	 * one (say, an agent artifact in an unpushed commit) gets an immediate turn.
	 */
	readonly urgent?: string
}

/** The report in `stop-checklist.ts`'s `report` output, or an error naming what was wrong. */
export function parseStopReport(stdout: string): StopReport {
	const report = (JSON.parse(stdout) as { report?: Partial<StopReport> }).report
	if (
		!report ||
		typeof report.key !== 'string' ||
		!Array.isArray(report.claims) ||
		!report.claims.every((claim) => typeof claim === 'string') ||
		typeof report.agentText !== 'string' ||
		(report.urgent !== undefined && typeof report.urgent !== 'string')
	) {
		throw new Error(`stop-checklist.ts returned no usable report: ${stdout.slice(0, 200)}`)
	}
	return { key: report.key, claims: report.claims, agentText: report.agentText, ...(report.urgent !== undefined ? { urgent: report.urgent } : {}) }
}

/**
 * The line drawn under the answer when the report changed: what drifted, in
 * the report's own words, and where the rest went. Claude Code shows it after
 * the mod's name (observed on 2.1.288: `obsidian-mind: …`).
 */
export function summaryLine(report: StopReport): string {
	const what = report.claims.length > 0 ? report.claims.join(' · ') : 'wrap-up checklist'
	return `vault check: ${what} · the full report reaches the agent with your next message`
}

/**
 * The text to return from `turn.complete`. A hook below that already set a
 * line of its own (its text differs from the answer) keeps it; ours goes
 * after it rather than replacing it.
 */
export function withLine(textBelow: string, answer: string, line: string): string {
	return textBelow !== answer && textBelow.trim() !== '' ? `${textBelow}\n${line}` : line
}

/**
 * Whether a prompt from this origin should carry the queued report: the
 * person's own prompts (typed, over Remote Control, or through the SDK) and
 * this mod's urgent prompt. A peer's message, a notification or a schedule
 * is not the person writing, and must not consume the report.
 */
export function carriesReport(origin: PromptOrigin | undefined): boolean {
	if (origin === undefined) return true
	if (origin.kind === 'plugin') return origin.name === 'obsidian-mind'
	return origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
}
