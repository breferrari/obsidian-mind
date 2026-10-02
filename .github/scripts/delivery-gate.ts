#!/usr/bin/env node
/**
 * Delivery gate (#267): ask the model what it received, never the logs.
 *
 * Every check the template had confirmed that a hook RAN. None confirmed what
 * ARRIVED, and from Claude Code 2.1.89 to the #254 fix, hook output past
 * 10,000 characters reached the model as a 2,000-character preview while
 * every log said success. The mod moves the session context to a channel
 * (an instruction file) on a young API, so the same failure is possible
 * again. This gate runs real Claude Code sessions in throwaway vaults and
 * asks the model to quote the LAST line of the context it was given:
 *
 *  - with the mod: at startup, in a session of its own; then in a second
 *    session after `/compact`, from a general-purpose subagent straight after
 *    `/clear`, and after `/clear`;
 *  - without the mod: at startup.
 *
 * Only the stream decides, and every other road the answer could take is
 * closed in the judge, not in the prompt. A checkpoint is INVALID, never
 * PASS, when: its turn used a tool; the `/compact` summary itself carried the
 * line; a `/compact` or `/clear` left no event of its own; the subagent was
 * not a general-purpose one, was handed the line in its prompt, used tools,
 * or did not report its tool count; with the mod, the settings hook printed
 * the context instead of standing down (or, without it, printed nothing); or
 * the session errored, timed out, ran an extra turn or ended early.
 *
 * What it does not cover: the mod is loaded with `--plugin-dir`, not found in
 * the vault's skills folder after the trust prompt as a user's is; and the
 * hook path's context in the fixture (under 1,000 characters) only shows that
 * something arrived, not that a long output was cut.
 *
 * Run it by hand on any Claude Code version before it is recommended, with a
 * logged-in `claude`:
 *
 *   node --experimental-strip-types .github/scripts/delivery-gate.ts [--model opus] [--claude <bin>]
 *
 * `--self-test` runs two broken copies of the mod instead: one cuts its
 * context to 2,000 characters everywhere, one delivers it whole only at
 * startup. Every checkpoint must FAIL, except the startup-only copy's own
 * startup, which must PASS (the control that proves that copy delivered).
 * It exits 0 when the gate can fail. Exit codes: 0 pass (or, with
 * `--self-test`, the gate can fail), 1 a checkpoint failed (or the gate is
 * broken), 2 the run could not be judged.
 *
 * It costs model turns on the caller's account, and it is not wired to CI: a
 * public repository's CI has no credentials to give it.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../.claude/scripts/lib/main-guard.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The question asked at every main-loop checkpoint. */
export const QUESTION =
	"Without using any tool, quote verbatim the last line of the obsidian-mind session context you were given (the line that starts with _context injected). If you cannot see it, reply NONE.";

/** The task the subagent must be given, word for word. */
export const SUBAGENT_TASK =
	"Without using any tool, reply with only the line in your own context or instructions that starts with _context injected, verbatim, or NONE if there is none.";

/** The same question, put to a general-purpose subagent; only its own report is judged. */
export const SUBAGENT_QUESTION = `Use the Agent tool to start one general-purpose subagent (subagent_type "general-purpose") with exactly this task and nothing else: '${SUBAGENT_TASK}' Then reply with the subagent's answer verbatim and nothing else.`;

/** A first turn that puts nothing about the context into the conversation. */
export const WARM_UP = "Reply with the single word OK.";

export type StepKind = "ask" | "ask-subagent" | "warm" | "compact" | "clear";
/** One turn of a session. A named step is a checkpoint; the others prepare the next one. */
export type Step = { readonly name: string; readonly kind: StepKind; readonly prompt: string };

const ask = (name: string): Step => ({ name, kind: "ask", prompt: QUESTION });

/**
 * The sessions a run is made of, each with the turns it sends. The subagent
 * is asked straight after `/clear`, before the main loop has quoted the line
 * in that conversation, so there is nothing for it to pass along.
 */
export function plan(withMod: boolean): ReadonlyArray<readonly Step[]> {
	if (!withMod) return [[ask("without the mod, at startup")]];
	return [
		[ask("at startup")],
		[
			{ name: "", kind: "warm", prompt: WARM_UP },
			{ name: "", kind: "compact", prompt: "/compact" },
			ask("after /compact"),
			{ name: "", kind: "clear", prompt: "/clear" },
			{ name: "from a subagent", kind: "ask-subagent", prompt: SUBAGENT_QUESTION },
			ask("after /clear"),
		],
	];
}

/** The last non-empty line of a text, trimmed. */
export function lastLine(text: string): string {
	return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";
}

/** Whether an answer quotes `expected`, ignoring quotes, backticks, emphasis marks and spacing a model may add or drop. */
export function quotes(answer: string, expected: string): boolean {
	const bare = (s: string) => s.replace(/[`"“”*_]/g, "").replace(/\s+/g, " ").trim();
	return bare(expected) !== "" && bare(answer).includes(bare(expected));
}

/** One Agent call: what the main loop asked for, and what came back. */
export type AgentCall = {
	readonly type: string | null;
	readonly prompt: string;
	/** The subagent's own words, or null when no result came back. */
	readonly report: string | null;
	/** Tools the subagent used, or null when the result did not say. */
	readonly toolUses: number | null;
};

/** What one turn of a stream-json transcript shows, up to and including its `result` event. */
export type Turn = {
	/** The main loop's own text. */
	readonly text: string;
	/** Tools the main loop called, by name. */
	readonly tools: readonly string[];
	readonly agentCalls: readonly AgentCall[];
	/** Tool uses seen in subagent messages streamed inline, if any. */
	readonly subagentToolUses: number;
	readonly compacted: boolean;
	/** The compaction summary the model wrote, when this turn compacted. */
	readonly summaries: readonly string[];
	readonly reset: boolean;
	/** What each settings SessionStart hook printed in this turn. */
	readonly sessionStartOutputs: readonly string[];
	/** Set when the turn ended in an error rather than a result. */
	readonly error: string | null;
};

type Block = { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; content?: unknown; input?: { prompt?: string; subagent_type?: string } };
type StreamEvent = {
	type?: string;
	subtype?: string;
	hook_event?: string;
	stdout?: string;
	isSynthetic?: boolean;
	parent_tool_use_id?: string | null;
	message?: { content?: Block[] | string };
	tool_use_result?: { content?: unknown; totalToolUseCount?: number; agentType?: string };
	is_error?: boolean;
	result?: string;
};

const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((b: Block) => (b.type === "text" ? (b.text ?? "") : "")).join("\n") : "";

/**
 * The subagent's own words from a framed Agent tool_result: what follows the
 * hand-back frame's "The report follows:" line, up to the `agentId:` footer
 * at the start of a line. Used only when the result carries no raw content.
 */
export function subagentReport(handedBack: string): string {
	const start = handedBack.indexOf("The report follows:");
	if (start < 0) return handedBack.trim();
	const body = handedBack.slice(start + "The report follows:".length);
	const end = body.search(/\nagentId:/);
	return (end < 0 ? body : body.slice(0, end)).trim();
}

/** Split a stream-json transcript into turns, one per `result` event. Events before the first result belong to the first turn. */
export function parseTurns(streamJson: string): Turn[] {
	const turns: Turn[] = [];
	const fresh = () => ({
		text: "",
		tools: [] as string[],
		calls: new Map<string, { type: string | null; prompt: string; report: string | null; toolUses: number | null }>(),
		subagentToolUses: 0,
		compacted: false,
		summaries: [] as string[],
		reset: false,
		sessionStartOutputs: [] as string[],
	});
	let t = fresh();
	for (const raw of streamJson.split("\n")) {
		let event: StreamEvent;
		try {
			event = JSON.parse(raw) as StreamEvent;
		} catch {
			continue;
		}
		const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
		if (event.type === "assistant") {
			for (const block of blocks) {
				if (event.parent_tool_use_id) {
					// A subagent's own message, streamed inline: its tools count against it, its text is not the parent's.
					if (block.type === "tool_use") t.subagentToolUses++;
				} else if (block.type === "text") t.text += `${block.text ?? ""}\n`;
				else if (block.type === "tool_use") {
					t.tools.push(block.name ?? "?");
					if (block.name === "Agent" && block.id) t.calls.set(block.id, { type: block.input?.subagent_type ?? null, prompt: block.input?.prompt ?? "", report: null, toolUses: null });
				}
			}
		} else if (event.type === "user") {
			if (event.isSynthetic && typeof event.message?.content === "string") t.summaries.push(event.message.content);
			for (const block of blocks) {
				const call = block.type === "tool_result" && block.tool_use_id ? t.calls.get(block.tool_use_id) : undefined;
				if (!call) continue;
				const result = event.tool_use_result;
				call.report = result?.content !== undefined ? textOf(result.content).trim() : subagentReport(textOf(block.content));
				call.toolUses = typeof result?.totalToolUseCount === "number" ? result.totalToolUseCount : null;
				call.type = result?.agentType ?? call.type;
			}
		} else if (event.type === "system" && event.subtype === "compact_boundary") t.compacted = true;
		else if (event.type === "system" && event.subtype === "hook_response" && event.hook_event === "SessionStart") t.sessionStartOutputs.push(event.stdout ?? "");
		else if (event.type === "conversation_reset") t.reset = true;
		else if (event.type === "result") {
			const error = event.is_error || event.subtype !== "success" ? `${event.subtype ?? "error"}: ${(event.result ?? "").slice(0, 200)}` : null;
			turns.push({ ...t, text: t.text.trim(), agentCalls: [...t.calls.values()], error });
			t = fresh();
		}
	}
	return turns;
}

export type Outcome = "PASS" | "FAIL" | "INVALID";
export type Verdict = { readonly checkpoint: string; readonly expected: string; readonly answer: string; readonly outcome: Outcome; readonly why: string };

/** How a session ended, for checkpoints it never reached. */
export type Ending = "complete" | "timeout" | "extra-turn";

/**
 * Judge one session against the line its context ends with. A checkpoint is
 * PASS or FAIL only when the stream shows the answer could have come from the
 * delivered context alone; anything else is INVALID, with the reason.
 */
export function judge(steps: readonly Step[], turns: readonly Turn[], expected: string, options: { withMod: boolean; ending?: Ending }): Verdict[] {
	const ending = options.ending ?? "complete";
	const verdicts: Verdict[] = [];
	// Who delivered: with the mod, every settings SessionStart must have stood down; without it, the first must have printed.
	const outputs = turns.flatMap((turn) => turn.sessionStartOutputs);
	let sessionProblem: string | null = null;
	if (options.withMod && outputs.some((out) => out.trim() !== "")) sessionProblem = "the settings hook printed the context: the mod did not deliver it";
	if (!options.withMod && !(turns[0]?.sessionStartOutputs ?? []).some((out) => out.trim() !== "")) sessionProblem = "the settings hook printed nothing at startup";
	let carried: string | null = null; // a preparing step that failed spoils the checkpoint after it
	steps.forEach((step, i) => {
		const turn = turns[i];
		let problem = sessionProblem ?? carried;
		if (!turn) problem ??= ending === "timeout" ? "the turn timed out" : ending === "extra-turn" ? "the session ran a turn nobody sent" : "the session ended before this turn";
		else if (turn.error) problem ??= `the turn failed (${turn.error})`;
		else if (step.kind === "compact" && !turn.compacted) problem ??= "/compact left no compact_boundary event";
		else if (step.kind === "compact" && turn.summaries.some((summary) => quotes(summary, expected))) problem ??= "the /compact summary itself carried the line";
		else if (step.kind === "clear" && !turn.reset) problem ??= "/clear left no conversation_reset event";
		else if (step.kind === "ask" && turn.tools.length > 0) problem ??= `the answer used tools (${turn.tools.join(", ")})`;
		else if (step.kind === "ask-subagent") {
			const calls = turn.agentCalls;
			if (calls.length !== 1 || calls[0]!.report === null) problem ??= "no single subagent answered: the main loop answered itself";
			else if (turn.tools.some((name) => name !== "Agent")) problem ??= `the main loop used tools (${turn.tools.join(", ")})`;
			else if (calls[0]!.type !== "general-purpose") problem ??= `the subagent was ${calls[0]!.type ?? "of no stated type"}, not general-purpose`;
			else if (quotes(calls[0]!.prompt, expected)) problem ??= "the main loop handed the line to the subagent in its prompt";
			else if (calls[0]!.toolUses === null) problem ??= "the subagent's tool count was not reported";
			else if (calls[0]!.toolUses > 0 || turn.subagentToolUses > 0) problem ??= `the subagent used ${Math.max(calls[0]!.toolUses, turn.subagentToolUses)} tool(s)`;
		}
		if (step.name === "") {
			carried = problem;
			return;
		}
		carried = null;
		const answer = step.kind === "ask-subagent" ? (turn?.agentCalls[0]?.report ?? "") : (turn?.text ?? "");
		if (problem === null && answer.trim() === "") problem = "no answer";
		const shown = quotes(answer, expected) ? expected : lastLine(answer);
		if (problem !== null) verdicts.push({ checkpoint: step.name, expected, answer: shown, outcome: "INVALID", why: problem });
		else verdicts.push({ checkpoint: step.name, expected, answer: shown, outcome: quotes(answer, expected) ? "PASS" : "FAIL", why: "" });
	});
	return verdicts;
}

/** Brain notes added to the fixture: enough to put the mod's context well past the hook cap and under its instruction budget. */
const FIXTURE_NOTES = 110;

/** Ways the self-test breaks a copy of the mod. */
export type Breakage = "none" | "cut" | "startup-only";

const DELIVERY = "await update($, sessionContext, () => text)";
const BROKEN: Record<Exclude<Breakage, "none">, string> = {
	cut: "await update($, sessionContext, () => text.slice(0, 2_000))",
	"startup-only": "await update($, sessionContext, () => (e.source === 'startup' ? text : text.slice(0, 2_000)))",
};

/** Every fixture this run created, so an interrupted run can still remove them. */
const fixtures = new Set<string>();

/** A throwaway vault: the template's files (tracked and new) plus brain notes, with the mod broken as asked. */
export function buildFixture(breakage: Breakage, notes = FIXTURE_NOTES): string {
	const vault = mkdtempSync(join(tmpdir(), "om-delivery-gate-"));
	fixtures.add(vault);
	const listed = spawnSync("git", ["-C", REPO, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).stdout;
	for (const file of new Set(listed.split("\0").filter(Boolean))) {
		if (!existsSync(join(REPO, file))) continue; // tracked but deleted locally
		mkdirSync(dirname(join(vault, file)), { recursive: true });
		cpSync(join(REPO, file), join(vault, file));
	}
	for (let i = 1; i <= notes; i++) {
		const n = String(i).padStart(3, "0");
		writeFileSync(
			join(vault, "brain", `Gate Rule ${n}.md`),
			`---\ndescription: "Standing rule ${n}, one of many that together push the brain index past the hook-output cap"\ntags:\n  - brain\n---\n\n# Gate Rule ${n}\n\n${"Body. ".repeat(20)}\n`,
		);
	}
	if (breakage !== "none") {
		const register = join(vault, ".claude/skills/obsidian-mind/hooks/register.ts");
		const source = readFileSync(register, "utf8");
		const broken = source.replace(DELIVERY, BROKEN[breakage]);
		if (broken === source) throw new Error(`self-test: the ${breakage} breakage did not land; the mod changed shape`);
		writeFileSync(register, broken);
	}
	spawnSync("git", ["init", "-q"], { cwd: vault });
	return vault;
}

/** The folders Claude Code keeps for a session run in `vault`: its project transcripts and its temp task folder. */
export function sessionDirs(vault: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const slug = vault.replace(/[^A-Za-z0-9-]/g, "-");
	if (!slug.includes("om-delivery-gate-")) return [];
	return [join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", slug), join(tmpdir(), "claude", slug)];
}

export function removeFixture(vault: string): void {
	for (const path of [vault, ...sessionDirs(vault)]) {
		try {
			rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
		} catch (error) {
			console.warn(`Could not remove ${path}: ${(error as Error).message}`);
		}
	}
	fixtures.delete(vault);
}

/** The caller's Claude Code variables a fixture session still needs: where config lives, how to reach a shell and how to authenticate. */
const KEPT_CLAUDE_VARIABLES = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]);

/**
 * The environment every process in the fixture runs with. The caller's other
 * Claude Code variables (a gate run from inside a session inherits them) and
 * NODE_PATH are dropped. npm's global prefix points at an empty folder, so qmd
 * does not resolve through it and session-start.ts skips its search
 * bootstrap: otherwise each throwaway vault starts a full qmd bootstrap and
 * embed that outlives the run and registers an index on the caller's machine.
 */
export function fixtureEnv(vault: string, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const kept = Object.entries(from).filter(([key]) => KEPT_CLAUDE_VARIABLES.has(key.toUpperCase()) || (!/^CLAUDE/i.test(key) && key.toUpperCase() !== "NODE_PATH"));
	return { ...Object.fromEntries(kept), npm_config_prefix: join(vault, ".gate-npm"), DISABLE_AUTOUPDATER: "1" };
}

/** What session-start.ts prints in the fixture, as the hook or as the mod's run (`deliver`). */
export function contextOf(vault: string, deliver: boolean): string {
	const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", join(vault, ".claude/scripts/session-start.ts")], {
		cwd: vault,
		input: JSON.stringify({ source: "startup", ...(deliver ? { om_mod: "deliver" } : {}) }),
		encoding: "utf8",
		env: { ...fixtureEnv(vault), CLAUDE_PROJECT_DIR: vault },
	});
	if (run.status !== 0) throw new Error(`session-start.ts failed: ${run.stderr}`);
	return run.stdout;
}

/** How long one turn may take before the session is abandoned. */
const TURN_TIMEOUT_MS = 5 * 60_000;

/** Run one paced session: each turn is sent once the previous one's result arrives. */
function session(vault: string, steps: readonly Step[], options: { claude: string; model: string; withMod: boolean }): Promise<{ transcript: string; ending: Ending }> {
	return new Promise((resolvePromise, reject) => {
		const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", options.model];
		// The main loop has the Agent tool and nothing else: an answer cannot come from reading the vault.
		args.push("--tools", "Agent", "--allowedTools", "Agent", "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--max-budget-usd", "5");
		if (options.withMod) args.push("--plugin-dir", join(vault, ".claude/skills/obsidian-mind"));
		const child = spawn(options.claude, args, { cwd: vault, env: fixtureEnv(vault), stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let sent = 0;
		let ending: Ending = "complete";
		let exited = false;
		let timer: NodeJS.Timeout | undefined;
		const stop = (why: Ending) => {
			ending = why;
			child.kill();
		};
		const send = () => {
			if (exited) return;
			const step = steps[sent++];
			if (!step) return child.stdin.end();
			clearTimeout(timer);
			timer = setTimeout(() => stop("timeout"), TURN_TIMEOUT_MS);
			child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: step.prompt } })}\n`);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
			const results = (out.match(/"type":"result"/g) ?? []).length;
			// A turn nobody sent (a plugin's own prompt) would pair every later step with the wrong turn.
			if (results > sent) stop("extra-turn");
			else if (results === sent) send();
		});
		child.stdin.on("error", () => {}); // a write to a child that already exited; its close settles the session
		child.stderr.resume(); // drained, so a chatty child cannot block on a full pipe
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(error.code === "ENOENT" || error.code === "EINVAL" ? new Error(`could not start ${options.claude}; on Windows pass --claude <path to claude.exe>`) : error);
		});
		child.on("close", () => {
			exited = true;
			clearTimeout(timer);
			resolvePromise({ transcript: out, ending });
		});
		send();
	});
}

/** One fresh fixture per session, checked before any turn is spent on it. */
async function runSession(steps: readonly Step[], breakage: Breakage, options: { claude: string; model: string; withMod: boolean }): Promise<Verdict[]> {
	const vault = buildFixture(breakage);
	try {
		const context = contextOf(vault, options.withMod);
		const expected = lastLine(context);
		if (options.withMod) {
			// Well past the hook cap, so a cut near it shows as a different last
			// line; and whole, not collapsed under the instruction budget, or the
			// gate would be checking a pointer.
			if (context.length <= 12_000) throw new Error(`fixture too small to test the cap: ${context.length} characters`);
			if (expected.includes("collapsed")) throw new Error(`fixture past the instruction budget, so the context collapsed: ${expected}`);
		}
		const { transcript, ending } = await session(vault, steps, options);
		return judge(steps, parseTurns(transcript), expected, { withMod: options.withMod, ending });
	} finally {
		removeFixture(vault);
	}
}

const print = (label: string, verdicts: readonly Verdict[]) => {
	for (const v of verdicts) {
		console.log(`${v.outcome.padEnd(7)} ${v.checkpoint}${label}${v.why ? ` (${v.why})` : ""}\n        expected: ${v.expected}\n        answered: ${v.answer}`);
	}
};

/** The self-test's expectation: every checkpoint fails, except the startup-only copy's own startup, its positive control. */
export function selfTestOutcome(runs: ReadonlyArray<{ readonly breakage: Breakage; readonly verdicts: readonly Verdict[] }>): { exitCode: 0 | 1 | 2; message: string } {
	const all = runs.flatMap((run) => run.verdicts.map((v) => ({ ...v, breakage: run.breakage })));
	const invalid = all.filter((v) => v.outcome === "INVALID").length;
	if (invalid > 0) return { exitCode: 2, message: `${invalid} checkpoint(s) could not be judged; fix the run before trusting the self-test.` };
	const wrong = all.filter((v) => v.outcome !== (v.breakage === "startup-only" && v.checkpoint === "at startup" ? "PASS" : "FAIL"));
	if (wrong.length > 0) return { exitCode: 1, message: `The gate is broken: ${wrong.map((v) => `${v.checkpoint} (${v.breakage}) ${v.outcome}`).join(", ")}.` };
	return { exitCode: 0, message: "The gate can fail: every checkpoint failed against both broken mods, and the startup-only control passed." };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const flag = (name: string, fallback: string) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
	};
	const selfTest = argv.includes("--self-test");
	const options = { claude: flag("--claude", "claude"), model: flag("--model", "opus") };
	const version = spawnSync(options.claude, ["--version"], { encoding: "utf8" }).stdout?.trim() || "unknown version";
	process.on("SIGINT", () => {
		for (const vault of fixtures) removeFixture(vault);
		process.exit(130);
	});
	console.log(`Delivery gate · ${version} · ${options.model}${selfTest ? " · SELF-TEST" : ""}\n`);

	if (selfTest) {
		const runs: Array<{ breakage: Breakage; verdicts: Verdict[] }> = [];
		for (const breakage of ["cut", "startup-only"] as const) {
			const verdicts: Verdict[] = [];
			for (const steps of plan(true)) verdicts.push(...(await runSession(steps, breakage, { ...options, withMod: true })));
			print(` [${breakage}]`, verdicts);
			runs.push({ breakage, verdicts });
		}
		const { exitCode, message } = selfTestOutcome(runs);
		console.log(`\n${message}`);
		process.exitCode = exitCode;
		return;
	}

	const verdicts: Verdict[] = [];
	for (const steps of plan(true)) verdicts.push(...(await runSession(steps, "none", { ...options, withMod: true })));
	for (const steps of plan(false)) verdicts.push(...(await runSession(steps, "none", { ...options, withMod: false })));
	print("", verdicts);
	const invalid = verdicts.filter((v) => v.outcome === "INVALID").length;
	const failed = verdicts.filter((v) => v.outcome === "FAIL").length;
	if (invalid > 0) console.log(`\n${invalid} checkpoint(s) could not be judged.`);
	if (failed > 0) console.log(`\n${failed} checkpoint(s) did not receive the whole context.`);
	if (invalid === 0 && failed === 0) console.log("\nAll checkpoints received the whole context.");
	process.exitCode = invalid > 0 ? 2 : failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
	// Anything that stops the run before a verdict (a fixture check, a missing binary) cannot be judged: exit 2, never 1.
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 2;
	});
}
