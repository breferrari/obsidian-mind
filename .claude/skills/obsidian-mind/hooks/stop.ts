/**
 * The Stop report as the mod receives it from `stop-checklist.ts` run with
 * `om_mod: "report"` (#264), and the one line the user sees for it (#266).
 */
export type StopReport = {
	/** The report's identity: the same findings give the same key. */
	readonly key: string
	/** The one-line-per-section summary the settings hook would show. */
	readonly summary: string
	/** One short claim per finding, e.g. "1 note(s) marked done but still in active/". */
	readonly claims: readonly string[]
	/** The full report, prefaced for the agent. */
	readonly agentText: string
	/**
	 * Set only for a finding that should not wait for the user's next message.
	 * The template's report has no such class today; a vault that adds one
	 * (say, an agent artifact in an unpushed commit) gets an immediate turn.
	 */
	readonly urgent?: string
}

/** The report in `stop-checklist.ts`'s `report` output, or an error naming what was wrong. */
export function parseStopReport(stdout: string): StopReport {
	const report = (JSON.parse(stdout) as { report?: Partial<StopReport> }).report
	if (
		!report ||
		typeof report.key !== 'string' ||
		typeof report.summary !== 'string' ||
		!Array.isArray(report.claims) ||
		typeof report.agentText !== 'string' ||
		(report.urgent !== undefined && typeof report.urgent !== 'string')
	) {
		throw new Error(`stop-checklist.ts returned no usable report: ${stdout.slice(0, 200)}`)
	}
	return report as StopReport
}

/**
 * The line drawn under the answer when the report changed: what drifted, in
 * the report's own words, and where the rest went. Claude Code prefixes it
 * with the mod's name.
 */
export function summaryLine(report: StopReport): string {
	const what = report.claims.length > 0 ? report.claims.join(' · ') : 'wrap-up checklist'
	return `vault check: ${what} · the full report reaches the agent with your next message`
}
