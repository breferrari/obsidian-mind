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
 *  - with the mod: at startup (a session of its own, so the line is never in
 *    the conversation before a compaction), then in a second session after
 *    `/compact`, after `/clear`, and from a general-purpose subagent;
 *  - without the mod: at startup.
 *
 * Only the stream decides. A checkpoint whose turn used any tool, a subagent
 * answer that is not the subagent's own report or that used tools, and a
 * `/compact` or `/clear` that left no event of its own make the run INVALID,
 * never PASS. A session that errors, times out or ends early is INVALID too.
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
 * startup. Every checkpoint must FAIL with a real answer, or the gate has
 * stopped being able to fail (#203). It exits 0 when the gate can fail.
 *
 * It costs model turns on the caller's account, and it is not wired to CI: a
 * public repository's CI has no credentials to give it.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../.claude/scripts/lib/main-guard.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The question asked at every main-loop checkpoint. */
export const QUESTION =
	"Without using any tool, quote verbatim the last line of the obsidian-mind session context you were given (the line that starts with _context injected). If you cannot see it, reply NONE.";

/** The same question, put to a general-purpose subagent; only its own report is judged. */
export const SUBAGENT_QUESTION =
	"Use the Agent tool to start one general-purpose subagent with this exact task: 'Without using any tool, reply with only the line in your own context or instructions that starts with _context injected, verbatim, or NONE if there is none.' Then reply with the subagent's answer verbatim and nothing else.";

/** A first turn that puts nothing about the context into the conversation. */
export const WARM_UP = "Reply with the single word OK.";

export type StepKind = "ask" | "ask-subagent" | "warm" | "compact" | "clear";
/** One turn of a session. A named step is a checkpoint; the others prepare the next one. */
export type Step = { readonly name: string; readonly kind: StepKind; readonly prompt: string };

const ask = (name: string): Step => ({ name, kind: "ask", prompt: QUESTION });

/** The sessions a run is made of, each with the turns it sends. */
export function plan(withMod: boolean): ReadonlyArray<readonly Step[]> {
	if (!withMod) return [[ask("without the mod, at startup")]];
	return [
		[ask("at startup")],
		[
			{ name: "", kind: "warm", prompt: WARM_UP },
			{ name: "", kind: "compact", prompt: "/compact" },
			ask("after /compact"),
			{ name: "", kind: "clear", prompt: "/clear" },
			ask("after /clear"),
			{ name: "from a subagent", kind: "ask-subagent", prompt: SUBAGENT_QUESTION },
		],
	];
}

/** The last non-empty line of a text, trimmed. */
export function lastLine(text: string): string {
	return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";
}

/** Whether an answer quotes `expected`, ignoring the backticks and quotes a model wraps a line in. */
export function quotes(answer: string, expected: string): boolean {
	const bare = (s: string) => s.replace(/[`"“”]/g, "").replace(/\s+/g, " ").trim();
	return expected !== "" && bare(answer).includes(bare(expected));
}

/** What one turn of a stream-json transcript shows, up to and including its `result` event. */
export type Turn = {
	/** The main loop's own text. */
	readonly text: string;
	/** Tools the main loop called, by name. */
	readonly tools: readonly string[];
	/** What each Agent call handed back: the subagent's own report. */
	readonly agentReports: readonly string[];
	/** Tools the subagents used, as their task notifications count them. */
	readonly subagentToolUses: number;
	readonly compacted: boolean;
	readonly reset: boolean;
	/** Set when the turn ended in an error rather than a result. */
	readonly error: string | null;
};

type Block = { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; content?: unknown };
type StreamEvent = {
	type?: string;
	subtype?: string;
	parent_tool_use_id?: string | null;
	message?: { content?: Block[] | string };
	usage?: { tool_uses?: number };
	is_error?: boolean;
	result?: string;
};

const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((b: Block) => (b.type === "text" ? (b.text ?? "") : "")).join("\n") : "";

/** Split a stream-json transcript into turns, one per `result` event. */
export function parseTurns(streamJson: string): Turn[] {
	const turns: Turn[] = [];
	let text = "";
	let tools: string[] = [];
	let agentIds = new Set<string>();
	let agentReports: string[] = [];
	let subagentToolUses = 0;
	let compacted = false;
	let reset = false;
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
					// A subagent's own message: its tools count against it, its text is not the parent's.
					if (block.type === "tool_use") subagentToolUses++;
				} else if (block.type === "text") text += `${block.text ?? ""}\n`;
				else if (block.type === "tool_use") {
					tools.push(block.name ?? "?");
					if (block.name === "Agent" && block.id) agentIds.add(block.id);
				}
			}
		} else if (event.type === "user") {
			for (const block of blocks) if (block.type === "tool_result" && block.tool_use_id && agentIds.has(block.tool_use_id)) agentReports.push(textOf(block.content));
		} else if (event.type === "system" && event.subtype === "compact_boundary") compacted = true;
		else if (event.type === "system" && event.subtype === "task_notification") subagentToolUses += event.usage?.tool_uses ?? 0;
		else if (event.type === "conversation_reset") reset = true;
		else if (event.type === "result") {
			const error = event.is_error || event.subtype !== "success" ? `${event.subtype ?? "error"}: ${(event.result ?? "").slice(0, 200)}` : null;
			turns.push({ text: text.trim(), tools, agentReports, subagentToolUses, compacted, reset, error });
			text = "";
			tools = [];
			agentIds = new Set();
			agentReports = [];
			subagentToolUses = 0;
			compacted = false;
			reset = false;
		}
	}
	return turns;
}

export type Outcome = "PASS" | "FAIL" | "INVALID";
export type Verdict = { readonly checkpoint: string; readonly expected: string; readonly answer: string; readonly outcome: Outcome; readonly why: string };

/**
 * Judge one session against the line its context ends with. A checkpoint is
 * PASS or FAIL only when the stream shows the answer could have come from the
 * context alone; anything else is INVALID, with the reason.
 */
export function judge(steps: readonly Step[], turns: readonly Turn[], expected: string): Verdict[] {
	const verdicts: Verdict[] = [];
	let carried: string | null = null; // a preparing step that failed spoils the checkpoint after it
	steps.forEach((step, i) => {
		const turn = turns[i];
		let problem = carried;
		if (!turn) problem ??= "the session ended before this turn";
		else if (turn.error) problem ??= `the turn failed (${turn.error})`;
		else if (step.kind === "compact" && !turn.compacted) problem ??= "/compact left no compact_boundary event";
		else if (step.kind === "clear" && !turn.reset) problem ??= "/clear left no conversation_reset event";
		else if (step.kind === "ask" && turn.tools.length > 0) problem ??= `the answer used tools (${turn.tools.join(", ")})`;
		else if (step.kind === "ask-subagent") {
			if (!turn.tools.includes("Agent") || turn.agentReports.length === 0) problem ??= "no subagent answered: the main loop answered itself";
			else if (turn.tools.some((t) => t !== "Agent")) problem ??= `the main loop used tools (${turn.tools.join(", ")})`;
			else if (turn.subagentToolUses > 0) problem ??= `the subagent used ${turn.subagentToolUses} tool(s)`;
		}
		if (step.name === "") {
			carried = problem;
			return;
		}
		carried = null;
		const answer = step.kind === "ask-subagent" ? (turn?.agentReports.join("\n") ?? "") : (turn?.text ?? "");
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

export function removeFixture(vault: string): void {
	try {
		rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
		fixtures.delete(vault);
	} catch (error) {
		console.warn(`Could not remove the fixture ${vault}: ${(error as Error).message}`);
	}
}

/**
 * The environment every process in the fixture runs with. The caller's
 * Claude Code variables (a gate run from inside a session inherits them) and
 * NODE_PATH are dropped. npm's global prefix points at an empty folder, so qmd
 * does not resolve through it and session-start.ts skips its search
 * bootstrap: otherwise each throwaway vault starts a full qmd bootstrap and
 * embed that outlives the run and registers an index on the caller's machine.
 */
export function fixtureEnv(vault: string, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const kept = Object.entries(from).filter(([key]) => key === "CLAUDE_CONFIG_DIR" || (!/^CLAUDE/i.test(key) && key.toUpperCase() !== "NODE_PATH"));
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

/** Run one paced session: each turn is sent once the previous one's result arrives. Resolves with the transcript. */
function session(vault: string, steps: readonly Step[], options: { claude: string; model: string; withMod: boolean }): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", options.model];
		// The main loop has the Agent tool and nothing else: an answer cannot come from reading the vault.
		args.push("--tools", "Agent", "--allowedTools", "Agent", "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--max-budget-usd", "5");
		if (options.withMod) args.push("--plugin-dir", join(vault, ".claude/skills/obsidian-mind"));
		const child = spawn(options.claude, args, { cwd: vault, env: fixtureEnv(vault), stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let sent = 0;
		let timer: NodeJS.Timeout | undefined;
		const arm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => child.kill(), TURN_TIMEOUT_MS);
		};
		const send = () => {
			const step = steps[sent++];
			if (!step) return child.stdin.end();
			arm();
			child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: step.prompt } })}\n`);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
			if ((out.match(/"type":"result"/g) ?? []).length === sent) send();
		});
		child.stderr.resume(); // drained, so a chatty child cannot block on a full pipe
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(error.code === "ENOENT" || error.code === "EINVAL" ? new Error(`could not start ${options.claude}; on Windows pass --claude <path to claude.exe>`) : error);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolvePromise(out);
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
		return judge(steps, parseTurns(await session(vault, steps, options)), expected);
	} finally {
		removeFixture(vault);
	}
}

const print = (verdicts: readonly Verdict[]) => {
	for (const v of verdicts) {
		console.log(`${v.outcome.padEnd(7)} ${v.checkpoint}${v.why ? ` (${v.why})` : ""}\n        expected: ${v.expected}\n        answered: ${v.answer}`);
	}
};

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
		const verdicts: Verdict[] = [];
		for (const steps of plan(true)) verdicts.push(...(await runSession(steps, "cut", { ...options, withMod: true })));
		// Delivered whole at startup only: everything after it must still fail.
		verdicts.push(...(await runSession(plan(true)[1]!, "startup-only", { ...options, withMod: true })));
		print(verdicts);
		const invalid = verdicts.filter((v) => v.outcome === "INVALID").length;
		const passed = verdicts.filter((v) => v.outcome === "PASS").length;
		if (invalid > 0) console.log(`\n${invalid} checkpoint(s) could not be judged; fix the run before trusting the self-test.`);
		else if (passed > 0) console.log(`\nThe gate is broken: ${passed} checkpoint(s) passed against a mod that does not deliver.`);
		else console.log("\nThe gate can fail: every checkpoint failed against both broken mods.");
		process.exitCode = invalid > 0 ? 2 : passed > 0 ? 1 : 0;
		return;
	}

	const verdicts: Verdict[] = [];
	for (const steps of plan(true)) verdicts.push(...(await runSession(steps, "none", { ...options, withMod: true })));
	for (const steps of plan(false)) verdicts.push(...(await runSession(steps, "none", { ...options, withMod: false })));
	print(verdicts);
	const invalid = verdicts.filter((v) => v.outcome === "INVALID").length;
	const failed = verdicts.filter((v) => v.outcome === "FAIL").length;
	if (invalid > 0) console.log(`\n${invalid} checkpoint(s) could not be judged.`);
	if (failed > 0) console.log(`\n${failed} checkpoint(s) did not receive the whole context.`);
	if (invalid === 0 && failed === 0) console.log("\nAll checkpoints received the whole context.");
	process.exitCode = invalid > 0 ? 2 : failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) await main();
