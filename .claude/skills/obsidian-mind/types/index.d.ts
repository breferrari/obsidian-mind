// The mod's per-session state: what the host keeps for it for the session,
// across a hot reload of the module.

declare module "claude-code" {
	interface PluginState {
		"obsidian-mind": {
			/** The session context this session's instruction file carries; null when none was delivered. */
			context: string | null;
		};
	}
}
