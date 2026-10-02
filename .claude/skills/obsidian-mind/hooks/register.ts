import type { EngineInterface, Register } from 'claude-code'
import { withSessionContext } from './context.ts'

/**
 * obsidian-mind's Claude Code mod (#262).
 *
 * The vault's settings hooks stay the engine: Codex and Gemini run them, and
 * so does Claude Code wherever this mod does not load (an older CLI, an
 * untrusted folder, a session launched in a vault subfolder, a policy that
 * allows only managed mods). This mod changes how their output reaches the
 * session, never what it says: it runs the same scripts and delivers the
 * result through a better channel.
 *
 * Session context (#265): `session-start.ts` runs here with
 * `om_mod: "deliver"`, and its output becomes an instruction file instead of
 * hook output. Unlike hook output it is not cut at 10,000 characters, it is
 * re-read whole after compaction and `/clear` instead of shrinking to a
 * pointer, and general-purpose subagents receive it.
 *
 * The switch is the event itself: the settings hook is passed
 * `om_mod: "standdown"` and exits, but only on an event this hook actually
 * handled. The work is done before `next`, so if it fails the hook throws,
 * Claude Code skips it, and the settings hook gets the original event and
 * runs as it would without the mod.
 */

/** Where the delivered context is also written, so /memory opens what the model received. Gitignored. */
const CONTEXT_FILE = '.claude/session-context.md'

let context: string | null = null

/** Run the vault's own SessionStart script for the instruction file. */
async function sessionContext($: EngineInterface, root: string, event: object): Promise<string> {
	const run = await $.process.run(
		['node', '--disable-warning=ExperimentalWarning', '--experimental-strip-types', `${root}/.claude/scripts/session-start.ts`],
		{ cwd: root, env: { CLAUDE_PROJECT_DIR: root }, stdin: JSON.stringify({ ...event, om_mod: 'deliver' }), timeoutMs: 30_000 },
	)
	if (run.exitCode !== 0 || run.stdout.trim() === '') {
		throw new Error(`session-start.ts exited ${run.exitCode}: ${run.stderr.slice(0, 300)}`)
	}
	return run.stdout
}

export const register: Register = (on) => {
	on('classic.SessionStart', async ($, e, next) => {
		const root = await $.session.root()
		context = await sessionContext($, root, e)
		try {
			await $.fs.write(`${root}/${CONTEXT_FILE}`, context)
		} catch {
			// Only /memory's view of the file is lost; the session still gets the context.
		}
		$.ui.invalidate('prompt.context')
		return next({ ...e, om_mod: 'standdown' } as typeof e)
	})

	on('prompt.context', async ($, e, next) => {
		const below = await next(e)
		if (context === null) return below
		return withSessionContext(below, `${await $.session.root()}/${CONTEXT_FILE}`, context)
	})
}
