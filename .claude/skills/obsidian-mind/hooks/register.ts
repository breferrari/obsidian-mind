import { atom, read, update, type EngineInterface, type PluginState, type Register } from "claude-code";
import { withSessionContext } from "./context.ts";
import { carriesReport, fromPerson, parseStopReport, summaryLine, withLine } from "./stop.ts";

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

/** The session context this session's instruction file carries; what prompt.context hands the model. */
const sessionContext = atom({ plugin: "obsidian-mind", key: "context" } as const, null);
/** The report waiting to be delivered: its text, and its line and urgent finding until they are used. */
const queued = atom({ plugin: "obsidian-mind", key: "queued" } as const, null);
/** Whether an urgent finding has had its turn since the person last spoke. */
const urgentSpent = atom({ plugin: "obsidian-mind", key: "urgentSpent" } as const, false);
/** Bumped by every start that begins another conversation, so a report in flight across one is not put back. */
const generation = atom({ plugin: "obsidian-mind", key: "generation" } as const, 0);
/**
 * The report a prompt took, until a turn starts with that prompt. A prompt
 * enters when it is queued, not when its turn starts, and a queued prompt can
 * be pulled back out of the queue; if a turn starts with another prompt
 * first, this one never ran, and the report goes back in the queue.
 */
const inFlight = atom({ plugin: "obsidian-mind", key: "inFlight" } as const, null);

type Queued = NonNullable<PluginState["obsidian-mind"]["queued"]>;

/**
 * Which report each session was last shown, by session id: in `$.store`, not
 * `$.state`, because the store outlives the process, so a `claude --resume`
 * in a new process does not show unchanged findings again (the settings
 * hook's dedupe is file-backed for the same reason). Only the most recent
 * sessions are kept.
 */
const SHOWN = "shown";
const SHOWN_KEEP = 20;

async function shownFor($: EngineInterface, sessionId: string): Promise<string | undefined> {
	const shown = ((await $.store.get(SHOWN)) ?? {}) as Record<string, string>;
	return shown[sessionId];
}

async function setShown($: EngineInterface, sessionId: string, key: string | null): Promise<void> {
	const shown = { ...(((await $.store.get(SHOWN)) ?? {}) as Record<string, string>) };
	delete shown[sessionId];
	if (key !== null) shown[sessionId] = key;
	// Insertion order is recency: drop the oldest sessions past the cap.
	const ids = Object.keys(shown);
	for (const id of ids.slice(0, Math.max(0, ids.length - SHOWN_KEEP))) delete shown[id];
	await $.store.set(SHOWN, shown);
}

/**
 * Run one of the vault's hook scripts with `input` on stdin; its stdout, or a
 * throw. `timeoutMs` matches the script's own timeout in settings.json, so the
 * mod never waits longer than the hook it replaces would have.
 */
async function runScript($: EngineInterface, root: string, script: string, input: object, timeoutMs: number): Promise<string> {
	const run = await $.process.run(["node", "--disable-warning=ExperimentalWarning", "--experimental-strip-types", `${root}/.claude/scripts/${script}`], {
		cwd: root,
		env: { CLAUDE_PROJECT_DIR: root },
		stdin: JSON.stringify(input),
		timeoutMs,
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
		// Only a compaction continues the same conversation. Every other start
		// (`/clear`, an in-process `/resume` or fork) may keep this process and
		// its `$.state`, and a report about another conversation must not ride
		// the first prompt of this one, so what was queued is dropped.
		if (e.source !== "compact") {
			let dropped: Queued | null = null;
			await update($, queued, (now) => {
				dropped = now;
				return null;
			});
			await update($, urgentSpent, () => false);
			await update($, generation, (now) => now + 1);
			await update($, inFlight, () => null);
			// A report dropped here never reached the agent, so the same findings
			// show again in the session it was for; one it already has stays shown.
			const lost: Queued | null = dropped;
			if (lost !== null) await setShown($, lost.sessionId, null);
		}
		// Cleared first: if this run fails, the settings hook delivers fresh
		// output and no earlier context may ride beside it.
		await update($, sessionContext, () => null);
		const root = await $.session.root();
		const text = await runScript($, root, "session-start.ts", { ...e, om_mod: "deliver" }, 30_000);
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

	on("prompt.context", async ($, e, next) => {
		const below = await next(e);
		const text = await read($, sessionContext);
		if (text === null) return below;
		return withSessionContext(below, `${await $.session.root()}/${CONTEXT_FILE}`, text);
	});

	on("classic.Stop", async ($, e, next) => {
		// A turn some Stop hook forced: the settings hook exits on its own.
		if (e.stop_hook_active) return next(e);
		const root = await $.session.root();
		const report = parseStopReport(await runScript($, root, "stop-checklist.ts", { ...e, om_mod: "report" }, 5_000));
		// Per session, so a new session shows its first report even with the
		// same findings, as the settings hook's dedupe does.
		const sessionId = String(e.session_id);
		if ((await shownFor($, sessionId)) !== report.key) {
			await setShown($, sessionId, report.key);
			// The urgent finding rides inside the report too, so whatever happens
			// to its own turn, the agent gets it with the report.
			const text = report.urgent === undefined ? report.agentText : `${report.agentText}\n\nUrgent: ${report.urgent}`;
			await update($, queued, (): Queued => ({ sessionId, report: text, line: summaryLine(report), urgent: report.urgent ?? null }));
		}
		return next({ ...e, om_mod: "standdown" } as typeof e);
	});

	on("turn.complete", async ($, e, next) => {
		const done = await next(e);
		// Only under a main-loop answer that completed: a subagent's turn, an
		// interrupted one or one an error ended keeps the line for the next.
		if (e.agentId !== undefined || e.reason !== "answer") return done;
		// The line and the urgent finding are used once; the report stays queued for the next prompt.
		let line: string | null = null;
		let urgent: string | null = null;
		await update($, queued, (now) => {
			line = now?.line ?? null;
			urgent = now?.urgent ?? null;
			return now === null || now.line === null ? now : { ...now, line: null, urgent: null };
		});
		if (line === null) return done;
		// One urgent turn per prompt the person sends: findings that keep
		// changing while the agent fixes them must not chain turns. A finding
		// that gets no turn still reaches the agent inside the queued report.
		if (urgent !== null && !(await read($, urgentSpent))) {
			await update($, urgentSpent, () => true);
			// Never from classic.Stop: the engine refuses a submit that would wait
			// on the turn the hook may be holding, and names turn.complete instead.
			// Framed as this plugin's message, so the model knows it is not the
			// person speaking. The report rides it (prompt.submit below); if the
			// prompt never enters, the report stays queued for the next one.
			$.prompt.submit({ text: urgent }).catch(() => {});
		}
		return { ...done, text: withLine(done.text, e.answer, line) };
	});

	on("prompt.submit", async ($, e, next) => {
		// The person speaking renews the urgent allowance, once their prompt has entered.
		const renew = async (entered: Awaited<ReturnType<typeof next>>) => {
			if (entered.drop === undefined && fromPerson(e.origin)) await update($, urgentSpent, () => false);
			return entered;
		};
		if (!carriesReport(e.origin)) return renew(await next(e));
		// The whole record is taken before `next`, so two prompts entering at
		// once cannot both carry it, and a report queued while this one enters
		// is a different record that nothing here touches. Put back if this
		// prompt never enters (dropped or blocked below, or a throw), unless a
		// newer one was queued meanwhile.
		let taken: Queued | null = null;
		await update($, queued, (now) => {
			taken = now;
			return null;
		});
		if (taken === null) return renew(await next(e));
		const record: Queued = taken;
		const startedIn = await read($, generation);
		// Put back only into the conversation it was taken from: a `/clear` or
		// resume while this prompt was entering has dropped the queue on purpose.
		// Read through `update`, whose function sees writes made during `next`.
		const putBack = async () => {
			let now = startedIn;
			await update($, generation, (g) => {
				now = g;
				return g;
			});
			if (now === startedIn) await update($, queued, (current) => current ?? record);
		};
		let entered: Awaited<ReturnType<typeof next>>;
		try {
			entered = await next({ ...e, context: [...(e.context ?? []), record.report] });
		} catch (error) {
			await putBack();
			throw error;
		}
		if (entered.drop !== undefined) {
			await putBack();
			return entered;
		}
		await update($, inFlight, () => ({ text: entered.text, record, generation: startedIn }));
		return renew(entered);
	});

	on("turn.start", async ($, e, next) => {
		// Only the main loop's prompts carry the report; a turn begun without a
		// prompt (a continuation, text "") says nothing about the queue.
		let held: PluginState["obsidian-mind"]["inFlight"] = null;
		await update($, inFlight, (now) => {
			held = now;
			return now === null || e.text === "" ? now : null;
		});
		const waiting: PluginState["obsidian-mind"]["inFlight"] = held;
		// Queued prompts run in order and may be folded into one turn, so a turn
		// whose text holds the prompt's ran it: delivered. Any other prompt's turn
		// starting first means the one holding the report left the queue unrun.
		if (waiting !== null && e.text !== "" && !e.text.includes(waiting.text)) {
			let now = waiting.generation;
			await update($, generation, (g) => {
				now = g;
				return g;
			});
			if (now === waiting.generation) await update($, queued, (current) => current ?? waiting.record);
		}
		return next(e);
	});
};
