// The mod's per-session state: what the host keeps for it for the session,
// across a hot reload of the module.

/** The session context this session's instruction file carries; null when none was delivered. */
export type SessionContext = string | null

declare module 'claude-code' {
	interface PluginState {
		'obsidian-mind': { context: SessionContext }
	}
}
