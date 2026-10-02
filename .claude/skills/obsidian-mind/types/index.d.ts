// The mod's per-session state: what the host keeps for it for the session,
// across a hot reload of the module.

declare module "claude-code" {
	interface PluginState {
		"obsidian-mind": {
			/** The session context this session's instruction file carries; null when none was delivered. */
			context: string | null
			/** The session id and identity of the last Stop report shown. */
			shownReport: string | null
			/** The line to draw under the next main-loop answer. */
			pendingLine: string | null
			/** The full report, for the next prompt. */
			pendingReport: string | null
			/** An urgent finding, for a turn of its own. */
			pendingUrgent: string | null
		}
	}
}
