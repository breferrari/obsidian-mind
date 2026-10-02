import { atom, read, update, type EngineInterface, type Register } from 'claude-code'
import { withSessionContext } from './context.ts'
import { carriesReport, parseStopReport, summaryLine, withLine } from './stop.ts'

/**
 * obsidian-mind's Claude Code mod (#262).
 *
 * The vault's settings hooks stay the engine: Codex and Gemini run them, and
 * so does Claude Code wherever this mod does not load (an older CLI, an
 * untrusted folder, a session launched in a vault subfolder, a policy that
 * allows only managed mods). This mod changes how their output reaches the
 * session, never what it says: it runs the vault's own scripts and delivers
 * the result through a better channel.
 *
 * Session context (#265): `session-start.ts` runs here with
 * `om_mod: "deliver"`, and its output becomes an instruction file instead of
 * hook output. Unlike hook output it is not cut at 10,000 characters, it is
 * re-read whole after compaction and `/clear` instead of shrinking to a
 * pointer, and general-purpose subagents receive it.
 *
 * Stop report (#266): `stop-checklist.ts` runs here with `om_mod: "report"`.
 * When the findings changed, the user sees one line under the answer and the
 * agent gets the full report with the next prompt, unseen. A finding marked
 * urgent gets a turn of its own at once.
 *
 * The switch is the event itself: the settings hook is passed
 * `om_mod: "standdown"` and exits, but only on an event this hook actually
 * handled. The work is done before `next`, so if it fails the hook throws,
 * Claude Code skips it, and the settings hook gets the original event and
 * runs as it would without the mod.
 *
 * What the hooks hand each other lives in `$.state`, not in module
 * variables: the host keeps it for the session, across a hot reload.
 */

/** Where the delivered context is also written, so /memory opens what the model received. Gitignored. */
const CONTEXT_FILE = ".claude/session-context.md";

const sessionContext = atom({ plugin: 'obsidian-mind', key: 'context' } as const, null)
const shownReport = atom({ plugin: 'obsidian-mind', key: 'shownReport' } as const, null)
const pendingLine = atom({ plugin: 'obsidian-mind', key: 'pendingLine' } as const, null)
const pendingReport = atom({ plugin: 'obsidian-mind', key: 'pendingReport' } as const, null)
const pendingUrgent = atom({ plugin: 'obsidian-mind', key: 'pendingUrgent' } as const, null)

/** Run one of the vault's hook scripts with `input` on stdin; its stdout, or a throw. */
async function runScript($: EngineInterface, root: string, script: string, input: object): Promise<string> {
	const run = await $.process.run(["node", "--disable-warning=ExperimentalWarning", "--experimental-strip-types", `${root}/.claude/scripts/${script}`], {
		cwd: root,
		env: { CLAUDE_PROJECT_DIR: root },
		stdin: JSON.stringify(input),
		timeoutMs: 30_000,
	});
	if (run.exitCode !== 0 || run.stdout.trim() === "") {
		throw new Error(`${script} exited ${run.exitCode}: ${run.stderr.slice(0, 300)}`);
	}
	// A cut output would stand the hook down for part of what it delivers.
	if (run.isStdoutTruncated) throw new Error(`${script} printed more than process.run keeps`);
	return run.stdout;
}

export const register: Register = (on) => {
	on("classic.SessionStart", async ($, e, next) => {
		// If this run fails, the settings hook runs instead. At a start that
		// begins a conversation it prints the full layer, so the old context is
		// cleared first (and the render redrawn) or it would ride beside the
		// fresh one. At a compaction it prints only a pointer, trusting the
		// static half to be in the conversation already; under the mod it never
		// was, so there the last good context is kept rather than lost.
		if (e.source !== "compact") {
			await update($, sessionContext, () => null);
			$.ui.invalidate("prompt.context");
		}
		const root = await $.session.root();
		const text = await runScript($, root, "session-start.ts", { ...e, om_mod: "deliver" });
		await update($, sessionContext, () => text);
		// Not awaited: delivery does not depend on the file, so a slow, hung or
		// failed write never holds up the session. The file only backs what
		// /memory shows. Runs are minutes apart (startup, then a compaction), so
		// two writes landing out of order is not a case worth machinery: a
		// deadline would need a timer that outlives this hook, and a chain
		// without one would let a hung write stall every later write.
		$.fs.write(`${root}/${CONTEXT_FILE}`, text).catch(() => {});
		$.ui.invalidate("prompt.context");
		return next({ ...e, om_mod: "standdown" } as typeof e);
	});

	on('prompt.context', async ($, e, next) => {
		const below = await next(e)
		const text = await read($, sessionContext)
		if (text === null) return below
		return withSessionContext(below, `${await $.session.root()}/${CONTEXT_FILE}`, text)
	})

	on('classic.Stop', async ($, e, next) => {
		// A turn some Stop hook forced: the settings hook exits on its own.
		if (e.stop_hook_active) return next(e)
		const root = await $.session.root()
		const report = parseStopReport(await runScript($, root, 'stop-checklist.ts', { ...e, om_mod: 'report' }))
		// Keyed by session too, so a new session shows its first report even
		// with the same findings, as the settings hook's dedupe does.
		const identity = `${e.session_id}:${report.key}`
		if ((await read($, shownReport)) !== identity) {
			await update($, shownReport, () => identity)
			await update($, pendingLine, () => summaryLine(report))
			await update($, pendingReport, () => report.agentText)
			await update($, pendingUrgent, () => report.urgent ?? null)
		}
		return next({ ...e, om_mod: 'standdown' } as typeof e)
	})

	on('turn.complete', async ($, e, next) => {
		const done = await next(e)
		// Only under a main-loop answer that completed: a subagent's turn, an
		// interrupted one or one an error ended keeps the line for the next.
		if (e.agentId !== undefined || e.reason !== 'answer') return done
		const line = await read($, pendingLine)
		if (line === null) return done
		await update($, pendingLine, () => null)
		const urgent = await read($, pendingUrgent)
		if (urgent !== null) {
			// Never from classic.Stop: the engine refuses a submit that would wait
			// on the turn the hook may be holding, and names turn.complete instead.
			// Framed as this plugin's message, so the model knows it is not the
			// person speaking. The full report rides it (prompt.submit below).
			await update($, pendingUrgent, () => null)
			$.prompt.submit({ text: urgent }).catch(() => {
				// Not submitted: the report stays queued for the person's next prompt.
			})
		}
		return { ...done, text: withLine(done.text, e.answer, line) }
	})

	on('prompt.submit', async ($, e, next) => {
		const report = await read($, pendingReport)
		if (report === null || !carriesReport(e.origin)) return next(e)
		const entered = await next({ ...e, context: [...(e.context ?? []), report] })
		// Cleared only once a prompt actually entered with it: a prompt dropped
		// or blocked below keeps the report for the next one.
		if (entered.drop === undefined) await update($, pendingReport, () => null)
		return entered
	})
}
