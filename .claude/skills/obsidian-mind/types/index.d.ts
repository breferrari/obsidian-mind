// The mod's per-session state: what the host keeps for it for the session,
// across a hot reload of the module.

declare module "claude-code" {
	interface PluginState {
		"obsidian-mind": {
			/** The session context this session's instruction file carries; null when none was delivered. */
			context: string | null
			/** The session id and identity of the last Stop report shown. */
			shownReport: string | null
			/**
			 * The Stop report waiting to be delivered: its full text for the next
			 * prompt, and the line and urgent finding until the next completed
			 * answer uses them. Null when nothing is waiting.
			 */
			queued: { readonly report: string; readonly line: string | null; readonly urgent: string | null } | null
			/** Whether an urgent finding has had its turn since the person last spoke. */
			urgentSpent: boolean
		}
	}
}
