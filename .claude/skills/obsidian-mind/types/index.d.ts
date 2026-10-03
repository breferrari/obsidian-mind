// The mod's per-session state: what the host keeps for it for the session,
// across a hot reload of the module. What must outlive the process (which
// report each session was shown) is in `$.store` instead; see register.ts.

declare module "claude-code" {
	interface PluginState {
		"obsidian-mind": {
			/** The session context this session's instruction file carries; null when none was delivered. */
			context: string | null;
			/**
			 * The Stop report waiting to be delivered: the session it is for, its full text for the next
			 * prompt, and the line and urgent finding until the next completed
			 * answer uses them. Null when nothing is waiting.
			 */
			queued: { readonly sessionId: string; readonly report: string; readonly line: string | null; readonly urgent: string | null } | null;
			/** Whether an urgent finding has had its turn since the person last spoke. */
			urgentSpent: boolean;
			/** Bumped by every start that begins another conversation (startup, /clear, resume, fork). */
			generation: number;
			/**
			 * The report a prompt took, the prompt's text and the generation it was
			 * taken in, until a turn starts with that prompt. Null when none is.
			 */
			inFlight: {
				readonly text: string;
				readonly record: { readonly sessionId: string; readonly report: string; readonly line: string | null; readonly urgent: string | null };
				readonly generation: number;
			} | null;
		};
	}
}
