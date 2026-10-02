// The mod's per-session state: what the host keeps for it across a hot reload
// of the module, reset on /clear (where classic.SessionStart fills it again).

/** The session context this session's instruction file carries; null when none was delivered. */
export type SessionContext = string | null

declare module 'claude-code' {
	interface PluginState {
		'obsidian-mind': { context: SessionContext }
	}
}
