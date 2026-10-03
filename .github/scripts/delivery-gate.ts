#!/usr/bin/env node
/**
 * Delivery gate (#267): ask the model what it received, never the logs.
 *
 * Every check the template had confirmed that a hook RAN. None confirmed what
 * ARRIVED, and from Claude Code 2.1.89 to the #254 fix, hook output past
 * 10,000 characters reached the model as a 2,000-character preview while
 * every log said success. The mod moves the session context to a channel
 * (an instruction file) on a young API, so the same failure is possible
 * again. This gate runs real Claude Code sessions in throwaway vaults and, at
 * each checkpoint, asks the model to quote two things from the context it was
 * given: its LAST line (the injection meter), and a marker token placed in a
 * brain note in its MIDDLE. A context cut anywhere loses one of them.
 *
 *  - with the mod: at startup, in a session of its own; then in a second
 *    session after `/compact`, from a general-purpose subagent straight after
 *    `/clear`, and after a second `/clear`;
 *  - without the mod (the settings hooks alone): at startup, after `/compact`
 *    and after `/clear`. The hook path's context is held under the hook cap by
 *    the template itself, so there it collapses the brain index to a pointer
 *    and only the last line is asked for.
 *
 * With the mod, each `/compact` and `/clear` first changes the fixture: one
 * more brain note moves the delivered size, and the marker is rewritten. So
 * the context delivered afterwards ends with a size, and carries a marker,
 * that nobody has quoted yet: neither a compaction summary nor an earlier
 * answer can supply them, only a fresh delivery can.
 *
 * Only the stream decides, and every other road an answer could take is
 * closed in the judge, not in the prompt. A checkpoint is INVALID, never PASS,
 * when: its turn used a tool; the `/compact` summary carried the new size or
 * marker, or could not be read; a `/compact` or `/clear` left no event of its
 * own; the subagent was not a general-purpose one, was handed the size or
 * marker in its prompt, used tools, or did not report its tool count; with the
 * mod, the settings hook printed the context instead of standing down (or,
 * without it, printed nothing); or the session errored, timed out, ran an
 * extra turn or ended early.
 *
 * Run it by hand on any Claude Code version before it is recommended, with a
 * logged-in `claude`:
 *
 *   node --experimental-strip-types .github/scripts/delivery-gate.ts [--trusted-dir <dir>] [--file-issue] [--model opus] [--claude <bin>]
 *
 * `--trusted-dir` loads the mod the way a user gets it: found in the vault's
 * `.claude/skills/` after the workspace-trust prompt, which a headless session
 * cannot accept. Give it an empty folder you have opened once in Claude Code
 * and trusted; the gate builds each session's vault in that exact folder
 * (trust does not extend to subfolders) and empties it afterwards. Without it,
 * the mod is loaded with `--plugin-dir` from a temp-folder vault.
 *
 * `--file-issue` opens a GitHub issue (with `gh`) when a checkpoint fails.
 *
 * `--self-test` runs two broken copies of the mod instead: one cuts its
 * context to 2,000 characters everywhere, one delivers it whole only at
 * startup. Every checkpoint must FAIL, except the startup-only copy's own
 * startup, which must PASS (the control that proves that copy delivered).
 *
 * Exit codes: 0 pass (with `--self-test`: the gate can fail); 1 a checkpoint
 * did not receive the current context (with `--self-test`: the gate is
 * broken); 2 the run could not be judged. A FAIL wins over an INVALID, and in
 * the self-test so does any PASS against a broken mod.
 *
 * It costs model turns on the caller's account, and it is not wired to CI: a
 * public repository's CI has no credentials to give it.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../.claude/scripts/lib/main-guard.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Claude Code's cap on a hook's output, and the preview it hands the model past it (#254). */
const HOOK_CAP_CHARS = 10_000;
const PREVIEW_CHARS = 2_000;
/** How far past the hook cap the mod's context must be, so a cut near the cap shows. */
const FIXTURE_MIN_CHARS = Math.round(HOOK_CAP_CHARS * 1.2);
/** Each session's spending cap, passed to `claude --max-budget-usd`. */
const SESSION_BUDGET_USD = "5";
/** How long one turn may take before the session is abandoned. */
const TURN_TIMEOUT_MS = 5 * 60_000;

/** What a checkpoint's answer must contain: the context's last line, and the middle marker when the context carries one. */
export type Expected = { readonly line: string; readonly marker: string | null };

/** The prefix of the marker token placed in the middle of the context. */
export const MARKER_PREFIX = "GATE-MARK-";

/** The question asked at every main-loop checkpoint. */
export const QUESTION = [
	"Without using any tool, reply with two things from the obsidian-mind session context you were given, verbatim:",
	"(1) its last line, the one that starts with _context injected;",
	`(2) the token in it that starts with ${MARKER_PREFIX}.`,
	"Write NONE for any you cannot see.",
].join(" ");

/** The task the subagent must be given, word for word. */
export const SUBAGENT_TASK = [
	"Without using any tool, reply with two things from your own context or instructions, verbatim:",
	"(1) the line that starts with _context injected;",
	`(2) the token that starts with ${MARKER_PREFIX}.`,
	"Write NONE for any you cannot see.",
].join(" ");

/** The same question, put to a general-purpose subagent; only its own report is judged. */
export const SUBAGENT_QUESTION = [
	'Use the Agent tool to start one general-purpose subagent (subagent_type "general-purpose") with exactly this task and nothing else:',
	`'${SUBAGENT_TASK}'`,
	"Then reply with the subagent's answer verbatim and nothing else.",
].join(" ");

/** A first turn that puts nothing about the context into the conversation. */
export const WARM_UP = "Reply with the single word OK.";

/** The kinds of step whose answer is judged; the rest prepare the next one. */
const CHECKPOINT_KINDS = ["ask", "ask-subagent"] as const;
type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];
type PreparingKind = "warm" | "compact" | "clear";
export type StepKind = CheckpointKind | PreparingKind;

/**
 * One turn of a session. A named step is a checkpoint; the others prepare the
 * next one. A step that shifts (every `/compact` and `/clear`) changes the
 * fixture just before it is sent, so the context delivered from then on ends
 * with a line nobody has seen yet.
 */
export type Step = { readonly name: string; readonly kind: StepKind; readonly prompt: string };

/** Whether a step starts a new delivery of the context: every `/compact` and `/clear`. */
export const shifts = (step: Step): boolean => step.kind === "compact" || step.kind === "clear";

/** Whether a step's answer is judged: the questions, not the turns that prepare them. */
export const isCheckpoint = (step: Step): boolean => (CHECKPOINT_KINDS as readonly string[]).includes(step.kind);

const prepare = (kind: PreparingKind, prompt: string): Step => ({ name: "", kind, prompt });
const ask = (name: string): Step => ({ name, kind: "ask", prompt: QUESTION });

/**
 * The sessions a run is made of, each with the turns it sends. The subagent
 * is asked straight after `/clear`, before the main loop has quoted anything
 * in that conversation, so there is nothing for it to be handed; the second
 * `/clear` clears the subagent's answer away before the main loop is asked.
 */
export function plan(withMod: boolean): ReadonlyArray<readonly Step[]> {
	if (!withMod) {
		return [
			[ask("without the mod, at startup")],
			[
				prepare("warm", WARM_UP),
				prepare("compact", "/compact"),
				ask("without the mod, after /compact"),
				prepare("clear", "/clear"),
				ask("without the mod, after /clear"),
			],
		];
	}
	return [
		[ask("at startup")],
		[
			prepare("warm", WARM_UP),
			prepare("compact", "/compact"),
			ask("after /compact"),
			prepare("clear", "/clear"),
			{ name: "from a subagent", kind: "ask-subagent", prompt: SUBAGENT_QUESTION },
			prepare("clear", "/clear"),
			ask("after /clear"),
		],
	];
}

/** The last non-empty line of a text, trimmed. */
export function lastLine(text: string): string {
	return (
		text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l !== "")
			.pop() ?? ""
	);
}

/** Whether an answer quotes `expected`, ignoring quotes, backticks, emphasis marks and spacing a model may add or drop. */
export function quotes(answer: string, expected: string): boolean {
	const bare = (s: string) =>
		s
			.replace(/[`"“”*_]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	return bare(expected) !== "" && bare(answer).includes(bare(expected));
}

/** Whether an answer gives everything a checkpoint expects: the last line, and the marker when there is one. */
export function answers(answer: string, want: Expected): boolean {
	return quotes(answer, want.line) && (want.marker === null || answer.includes(want.marker));
}

/** The delivered size on a context's meter line (`15.2` from `_context injected: 15.2kB / ...`), or undefined. */
export const meterSize = (line: string): string | undefined => line.match(/(\d+(?:\.\d+)?)\s*kB/i)?.[1];

/** Whether a meter line says the context collapsed sections to fit its budget. */
const collapsed = (line: string): boolean => line.includes("collapsed");

/**
 * Whether a text carries enough to rebuild what a checkpoint expects: the
 * whole line, its delivered size as a number on its own (`15.2`, whatever unit
 * follows; not the budget, which stays the same when the context changes), or
 * the marker. Used where none of it may travel (a compaction summary, a
 * subagent's prompt); stricter than `quotes` on purpose, since there a false
 * alarm costs a rerun and a miss costs a false PASS.
 */
export function carries(text: string, want: Expected): boolean {
	if (quotes(text, want.line)) return true;
	if (want.marker !== null && text.includes(want.marker)) return true;
	const size = meterSize(want.line);
	return size !== undefined && new RegExp(`(?<![\\d.])${size.replace(".", "\\.")}(?![\\d])`).test(text);
}

/** One Agent call: what the main loop asked for, and what came back. */
export type AgentCall = {
	readonly type: string | null;
	/** Everything the main loop handed the subagent: its description and its prompt. */
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

type Block = {
	type?: string;
	text?: string;
	name?: string;
	id?: string;
	tool_use_id?: string;
	content?: unknown;
	input?: { prompt?: string; description?: string; subagent_type?: string };
};
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
		calls: new Map<string, { -readonly [K in keyof AgentCall]: AgentCall[K] }>(),
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
					if (block.name === "Agent" && block.id) {
						const prompt = [block.input?.description, block.input?.prompt].filter(Boolean).join("\n");
						t.calls.set(block.id, { type: block.input?.subagent_type ?? null, prompt, report: null, toolUses: null });
					}
				}
			}
		} else if (event.type === "user") {
			if (event.isSynthetic) t.summaries.push(textOf(event.message?.content));
			for (const block of blocks) {
				const call = block.type === "tool_result" && block.tool_use_id ? t.calls.get(block.tool_use_id) : undefined;
				if (!call) continue;
				const result = event.tool_use_result;
				call.report = result?.content !== undefined ? textOf(result.content).trim() : subagentReport(textOf(block.content));
				call.toolUses = typeof result?.totalToolUseCount === "number" ? result.totalToolUseCount : null;
				call.type = result?.agentType ?? call.type;
			}
		} else if (event.type === "system" && event.subtype === "compact_boundary") t.compacted = true;
		else if (event.type === "system" && event.subtype === "hook_response" && event.hook_event === "SessionStart")
			t.sessionStartOutputs.push(event.stdout ?? "");
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

/** A checkpoint's expectation given as just a line (no marker) or in full. */
type ExpectedInput = string | Expected;
const asExpected = (e: ExpectedInput | undefined): Expected =>
	e === undefined ? { line: "", marker: null } : typeof e === "string" ? { line: e, marker: null } : e;

/** Why the subagent step cannot be judged, or null when it can. */
function subagentProblem(turn: Turn, want: Expected): string | null {
	const calls = turn.agentCalls;
	const call = calls[0];
	if (calls.length !== 1 || call === undefined || call.report === null) return "no single subagent answered: the main loop answered itself";
	if (turn.tools.some((name) => name !== "Agent")) return `the main loop used tools (${turn.tools.join(", ")})`;
	if (call.type !== "general-purpose") return `the subagent was ${call.type ?? "of no stated type"}, not general-purpose`;
	if (carries(call.prompt, want)) return "the main loop handed the line or marker to the subagent in its prompt or description";
	if (call.toolUses === null) return "the subagent's tool count was not reported";
	if (call.toolUses > 0 || turn.subagentToolUses > 0) return `the subagent used ${Math.max(call.toolUses, turn.subagentToolUses)} tool(s)`;
	return null;
}

/**
 * Judge one session against what its context carries. A checkpoint is PASS or
 * FAIL only when the stream shows the answer could have come from the
 * delivered context alone; anything else is INVALID, with the reason.
 */
export function judge(
	steps: readonly Step[],
	turns: readonly Turn[],
	expected: ExpectedInput | readonly ExpectedInput[],
	options: { withMod: boolean; ending?: Ending },
): Verdict[] {
	// One expectation for the whole session, or one per step when the fixture shifts during it.
	const expectedAt = (i: number): Expected => asExpected(Array.isArray(expected) ? (expected as readonly ExpectedInput[])[i] : (expected as ExpectedInput));
	const ending = options.ending ?? "complete";
	const verdicts: Verdict[] = [];
	// Who delivered: with the mod, every settings SessionStart must have stood down; without it, the first must have printed.
	const outputs = turns.flatMap((turn) => turn.sessionStartOutputs);
	let sessionProblem: string | null = null;
	if (options.withMod && outputs.some((out) => out.trim() !== "")) sessionProblem = "the settings hook printed the context: the mod did not deliver it";
	if (!options.withMod && !(turns[0]?.sessionStartOutputs ?? []).some((out) => out.trim() !== ""))
		sessionProblem = "the settings hook printed nothing at startup";
	// Every sent step yields exactly one result (2.1.288, /compact and /clear included); more means a turn nobody sent, and every pairing after it is wrong.
	if (turns.length > steps.length) sessionProblem ??= "the session ran a turn nobody sent";
	let carried: string | null = null; // a preparing step that failed spoils the checkpoint after it
	steps.forEach((step, i) => {
		const turn = turns[i];
		const want = expectedAt(i);
		let problem = sessionProblem ?? carried;
		if (!turn)
			problem ??=
				ending === "timeout" ? "the turn timed out" : ending === "extra-turn" ? "the session ran a turn nobody sent" : "the session ended before this turn";
		else if (turn.error) problem ??= `the turn failed (${turn.error})`;
		else if (step.kind === "compact" && !turn.compacted) problem ??= "/compact left no compact_boundary event";
		else if (step.kind === "compact" && turn.summaries.every((summary) => summary.trim() === ""))
			problem ??= "the /compact summary could not be read, so it cannot be cleared of the line";
		else if (step.kind === "compact" && turn.summaries.some((summary) => carries(summary, want)))
			problem ??= "the /compact summary itself carried the line or marker";
		else if (step.kind === "clear" && !turn.reset) problem ??= "/clear left no conversation_reset event";
		else if (step.kind === "ask" && turn.tools.length > 0) problem ??= `the answer used tools (${turn.tools.join(", ")})`;
		else if (step.kind === "ask-subagent") problem ??= subagentProblem(turn, want);
		if (!isCheckpoint(step)) {
			carried = problem;
			return;
		}
		carried = null;
		const answer = step.kind === "ask-subagent" ? (turn?.agentCalls[0]?.report ?? "") : (turn?.text ?? "");
		if (problem === null && answer.trim() === "") problem = "no answer";
		const hit = answers(answer, want);
		const shown = hit ? want.line : lastLine(answer);
		const verdict = { checkpoint: step.name, expected: want.line + (want.marker ? ` + ${want.marker}` : ""), answer: shown };
		if (problem !== null) verdicts.push({ ...verdict, outcome: "INVALID", why: problem });
		else if (hit) verdicts.push({ ...verdict, outcome: "PASS", why: "" });
		else
			verdicts.push({
				...verdict,
				outcome: "FAIL",
				why: failReason(
					answer,
					want,
					steps.slice(0, i).map((_, j) => expectedAt(j)),
				),
			});
	});
	return verdicts;
}

/** What a FAIL looked like: the tail without the middle, a context from before a shift, or nothing recognisable. */
function failReason(answer: string, want: Expected, earlier: readonly Expected[]): string {
	if (quotes(answer, want.line) && want.marker !== null) return "the middle of the context did not arrive: the last line did, the marker did not";
	const stale = earlier.some(
		(e) => e.line !== "" && e.line !== want.line && (quotes(answer, e.line) || (e.marker !== null && e.marker !== want.marker && answer.includes(e.marker))),
	);
	return stale ? "stale: it quoted the context from before the shift" : "";
}

/** Brain notes added to the fixture: enough to put the mod's context well past the hook cap and under its instruction budget. */
const FIXTURE_NOTES = 110;
/** The note that carries the marker: the middle of the brain index, which is the middle of the context. */
const MARKER_NOTE = 55;

/** Ways the self-test breaks a copy of the mod. */
export type Breakage = "none" | "cut" | "startup-only";

const DELIVERY = "await update($, sessionContext, () => text)";
const BROKEN: Record<Exclude<Breakage, "none">, string> = {
	cut: `await update($, sessionContext, () => text.slice(0, ${PREVIEW_CHARS}))`,
	"startup-only": `await update($, sessionContext, () => (e.source === 'startup' ? text : text.slice(0, ${PREVIEW_CHARS})))`,
};

/** A fresh marker token. */
export const newMarker = (): string => `${MARKER_PREFIX}${randomBytes(4).toString("hex").toUpperCase()}`;

/** A brain note with a description and a short body, as the fixture writes them. */
function brainNote(title: string, description: string): string {
	return `---\ndescription: "${description}"\ntags:\n  - brain\n---\n\n# ${title}\n\n${"Body. ".repeat(20)}\n`;
}

/** Write the brain note that carries the marker, in the middle of the index. */
function writeMarkerNote(vault: string, marker: string): void {
	const n = String(MARKER_NOTE).padStart(3, "0");
	writeFileSync(
		join(vault, "brain", `Gate Rule ${n}.md`),
		brainNote(`Gate Rule ${n}`, `Standing rule ${n}, holding the marker ${marker} in the middle of the brain index`),
	);
}

/** The file that marks a folder as the gate's own, so it is never asked to empty anything else. */
const FIXTURE_MARK = ".om-delivery-gate";

/** Every fixture this run created, so an interrupted run can still remove them. */
const fixtures = new Map<string, { trusted: boolean }>();

/**
 * Empty a trusted folder for the next fixture. It must be empty or the gate's
 * own (it holds the mark file): the gate never clears a folder it did not make.
 */
function emptyTrustedDir(dir: string): void {
	if (!existsSync(dir)) throw new Error(`--trusted-dir ${dir} does not exist; create it, open it once in Claude Code and trust it`);
	const entries = readdirSync(dir);
	if (entries.length > 0 && !entries.includes(FIXTURE_MARK))
		throw new Error(`--trusted-dir ${dir} is not empty and not the gate's own; give it an empty folder`);
	for (const entry of entries) if (entry !== FIXTURE_MARK) rmSync(join(dir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
	writeFileSync(join(dir, FIXTURE_MARK), "This folder belongs to the obsidian-mind delivery gate, which empties it before and after each session.\n");
}

/**
 * A throwaway vault: the template's files (tracked and new) plus brain notes,
 * with the mod broken as asked and `marker` in the middle note. It is built in
 * a fresh folder under the OS temp folder, or in `trustedDir` itself.
 * `withMod: false` turns the repo-shipped mod off for the vault, so a trusted
 * folder runs the settings hooks alone.
 */
export function buildFixture(
	breakage: Breakage,
	options: { marker?: string; trustedDir?: string | undefined; withMod?: boolean; notes?: number } = {},
): string {
	const { marker = newMarker(), trustedDir, withMod = true, notes = FIXTURE_NOTES } = options;
	let vault: string;
	if (trustedDir === undefined) vault = mkdtempSync(join(tmpdir(), "om-delivery-gate-"));
	else {
		emptyTrustedDir(trustedDir);
		vault = trustedDir;
	}
	fixtures.set(vault, { trusted: trustedDir !== undefined });
	const listed = spawnSync("git", ["-C", REPO, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).stdout;
	for (const file of new Set(listed.split("\0").filter(Boolean))) {
		if (!existsSync(join(REPO, file))) continue; // tracked but deleted locally
		mkdirSync(dirname(join(vault, file)), { recursive: true });
		cpSync(join(REPO, file), join(vault, file));
	}
	// A vault copied from infrastructure alone has no brain/ of its own.
	mkdirSync(join(vault, "brain"), { recursive: true });
	for (let i = 1; i <= notes; i++) {
		const n = String(i).padStart(3, "0");
		if (i === MARKER_NOTE) continue;
		writeFileSync(
			join(vault, "brain", `Gate Rule ${n}.md`),
			brainNote(`Gate Rule ${n}`, `Standing rule ${n}, one of many that together push the brain index past the hook-output cap`),
		);
	}
	if (notes >= MARKER_NOTE) writeMarkerNote(vault, marker);
	if (breakage !== "none") {
		const register = join(vault, ".claude/skills/obsidian-mind/hooks/register.ts");
		const source = readFileSync(register, "utf8");
		const broken = source.replace(DELIVERY, BROKEN[breakage]);
		if (broken === source) throw new Error(`self-test: the ${breakage} breakage did not land; the mod changed shape`);
		writeFileSync(register, broken);
	}
	if (!withMod) {
		writeFileSync(join(vault, ".claude/settings.local.json"), JSON.stringify({ enabledPlugins: { "obsidian-mind@skills-dir": false } }, null, 2) + "\n");
	}
	spawnSync("git", ["init", "-q"], { cwd: vault });
	return vault;
}

/** The folders Claude Code keeps for a session run in `vault`: its project transcripts and its temp task folder. */
export function sessionDirs(vault: string, env: NodeJS.ProcessEnv = process.env, real: (path: string) => string = realOrSame): string[] {
	// The path as created and as resolved (macOS's /var is /private/var): Claude Code may slug either.
	const slugs = [...new Set([vault, real(vault)].map((path) => path.replace(/[^A-Za-z0-9-]/g, "-")))].filter((slug) => slug.includes("om-delivery-gate-"));
	return slugs.flatMap((slug) => [join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", slug), join(tmpdir(), "claude", slug)]);
}

function realOrSame(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Remove a temp fixture and its session folders, or empty a trusted one (keeping the folder and its trust). */
export function removeFixture(vault: string): void {
	try {
		if (fixtures.get(vault)?.trusted) emptyTrustedDir(vault);
		else for (const path of [vault, ...sessionDirs(vault)]) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
	} catch (error) {
		console.warn(`Could not clean up ${vault}: ${(error as Error).message}`);
	}
	fixtures.delete(vault);
}

/** The caller's Claude Code variables a fixture session still needs: where config lives, how to reach a shell and how to authenticate. */
const KEPT_CLAUDE_VARIABLES = new Set([
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_GIT_BASH_PATH",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
]);

/**
 * The environment every process in the fixture runs with. The caller's other
 * Claude Code variables (a gate run from inside a session inherits them) and
 * NODE_PATH are dropped. npm's global prefix points at an empty folder, so qmd
 * does not resolve through it and session-start.ts skips its search
 * bootstrap: otherwise each throwaway vault starts a full qmd bootstrap and
 * embed that outlives the run and registers an index on the caller's machine.
 */
export function fixtureEnv(vault: string, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const kept = Object.entries(from).filter(
		([key]) => KEPT_CLAUDE_VARIABLES.has(key.toUpperCase()) || (!/^CLAUDE/i.test(key) && key.toUpperCase() !== "NODE_PATH"),
	);
	return { ...Object.fromEntries(kept), npm_config_prefix: join(vault, ".gate-npm"), DISABLE_AUTOUPDATER: "1" };
}

/** What session-start.ts prints in the fixture for a start of `source`, as the hook or as the mod's run (`deliver`). */
export function contextOf(vault: string, deliver: boolean, source: "startup" | "compact" | "clear" = "startup"): string {
	const run = spawnSync(
		process.execPath,
		["--disable-warning=ExperimentalWarning", "--experimental-strip-types", join(vault, ".claude/scripts/session-start.ts")],
		{
			cwd: vault,
			input: JSON.stringify({ source, ...(deliver ? { om_mod: "deliver" } : {}) }),
			encoding: "utf8",
			env: { ...fixtureEnv(vault), CLAUDE_PROJECT_DIR: vault },
		},
	);
	if (run.status !== 0) throw new Error(`session-start.ts failed: ${run.stderr}`);
	return run.stdout;
}

/** What a context makes a checkpoint expect: its last line, and the marker if the context carries it. */
export function expectedOf(context: string, marker: string): Expected {
	return { line: lastLine(context), marker: context.includes(marker) ? marker : null };
}

/**
 * Change the fixture so the context delivered from now on carries what nobody
 * has quoted: one more brain note moves the delivered size, and the middle
 * note gets a new marker. Returns the new expectation; throws if the size did
 * not move or the context collapsed, either of which would leave the
 * checkpoints after it unable to tell fresh delivery from memory.
 */
export function shiftFixture(vault: string, n: number, before: Expected): Expected {
	writeFileSync(
		join(vault, "brain", `Gate Shift ${n}.md`),
		brainNote(`Gate Shift ${n}`, `Added mid-session (shift ${n}) so the context ends with a size nobody has quoted yet; ${"padding ".repeat(30)}`),
	);
	const marker = newMarker();
	writeMarkerNote(vault, marker);
	const after = expectedOf(contextOf(vault, true), marker);
	if (meterSize(after.line) === undefined || meterSize(after.line) === meterSize(before.line))
		throw new Error(`shift ${n} did not move the delivered size: ${after.line}`);
	if (collapsed(after.line)) throw new Error(`shift ${n} pushed the context past the instruction budget, so it collapsed: ${after.line}`);
	if (after.marker === null) throw new Error(`shift ${n}: the new marker is not in the delivered context`);
	return after;
}

/**
 * Called once per step, just before it is sent: what that step's answer must
 * give. The starting expectation until a step starts a new delivery; from
 * then on what `next` returned for it, so a shift lands before the step that
 * causes the re-delivery, never earlier.
 */
export function expectationTracker(start: Expected, next: (n: number, before: Expected, step: Step) => Expected): (step: Step) => Expected {
	let current = start;
	let count = 0;
	return (step) => {
		if (shifts(step)) current = next(++count, current, step);
		return current;
	};
}

/**
 * The `result` events in the lines a chunk completes, and the line still
 * arriving. Counting as lines complete keeps pacing linear in the transcript,
 * and an event split across two chunks is counted once, when its line ends.
 */
export function countResults(pending: string, chunk: string): { results: number; pending: string } {
	const lines = (pending + chunk).split("\n");
	const rest = lines.pop() ?? "";
	let results = 0;
	for (const line of lines) {
		try {
			if ((JSON.parse(line) as { type?: string }).type === "result") results++;
		} catch {
			/* not an event line */
		}
	}
	return { results, pending: rest };
}

/** How one session is run. */
type SessionOptions = { readonly claude: string; readonly model: string; readonly withMod: boolean; readonly trustedDir?: string | undefined };

/** Run one paced session: each turn is sent once the previous one's result arrives, after `beforeSend` has run for it. */
function session(
	vault: string,
	steps: readonly Step[],
	options: SessionOptions,
	beforeSend: (step: Step, index: number) => void = () => {},
): Promise<{ transcript: string; ending: Ending }> {
	return new Promise((resolvePromise, reject) => {
		const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", options.model];
		// The main loop has the Agent tool and nothing else: an answer cannot come from reading the vault.
		args.push("--tools", "Agent", "--allowedTools", "Agent", "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
		args.push("--max-budget-usd", SESSION_BUDGET_USD);
		// In a trusted folder the mod is found the way a user's is; elsewhere it is loaded by path.
		if (options.withMod && options.trustedDir === undefined) args.push("--plugin-dir", join(vault, ".claude/skills/obsidian-mind"));
		const child = spawn(options.claude, args, { cwd: vault, env: fixtureEnv(vault), stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let pending = ""; // the line still arriving
		let results = 0;
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
			const index = sent++;
			const step = steps[index];
			if (!step) return child.stdin.end();
			try {
				beforeSend(step, index);
			} catch (error) {
				child.kill();
				reject(error);
				return;
			}
			clearTimeout(timer);
			timer = setTimeout(() => stop("timeout"), TURN_TIMEOUT_MS);
			child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: step.prompt } })}\n`);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
			const counted = countResults(pending, chunk);
			pending = counted.pending;
			results += counted.results;
			// A turn nobody sent (a plugin's own prompt) would pair every later step with the wrong turn.
			if (results > sent) stop("extra-turn");
			else if (results === sent) send();
		});
		child.stdin.on("error", () => {}); // a write to a child that already exited; its close settles the session
		child.stderr.resume(); // drained, so a chatty child cannot block on a full pipe
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(
				error.code === "ENOENT" || error.code === "EINVAL"
					? new Error(`could not start ${options.claude}; on Windows pass --claude <path to claude.exe>`)
					: error,
			);
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
async function runSession(steps: readonly Step[], breakage: Breakage, options: SessionOptions): Promise<Verdict[]> {
	const marker = newMarker();
	const vault = buildFixture(breakage, { marker, trustedDir: options.trustedDir, withMod: options.withMod });
	try {
		const context = contextOf(vault, options.withMod);
		const start = expectedOf(context, marker);
		if (options.withMod) {
			// Well past the hook cap, so a cut near it shows; whole, not collapsed
			// under the instruction budget, or the gate would be checking a
			// pointer; and the marker in its middle, so a cut there shows too.
			if (context.length <= FIXTURE_MIN_CHARS) throw new Error(`fixture too small to test the cap: ${context.length} characters`);
			if (collapsed(start.line)) throw new Error(`fixture past the instruction budget, so the context collapsed: ${start.line}`);
			const at = context.indexOf(marker) / context.length;
			if (at < 0.25 || at > 0.75) throw new Error(`the marker sits at ${Math.round(at * 100)}% of the context, not in its middle`);
		}
		// With the mod, a new delivery follows a shifted fixture. Without it, the
		// hook prints what session-start gives that start's source.
		const next = (n: number, before: Expected, step: Step): Expected =>
			options.withMod ? shiftFixture(vault, n, before) : expectedOf(contextOf(vault, false, step.kind === "compact" ? "compact" : "clear"), marker);
		const expectFor = expectationTracker(start, next);
		const expectedByStep: Expected[] = [];
		const { transcript, ending } = await session(vault, steps, options, (step, index) => {
			expectedByStep[index] = expectFor(step);
		});
		// Steps never sent (the session stopped early) are INVALID whatever their expectation.
		return judge(
			steps,
			parseTurns(transcript),
			steps.map((_, i) => expectedByStep[i] ?? ""),
			{ withMod: options.withMod, ending },
		);
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
export function selfTestOutcome(runs: ReadonlyArray<{ readonly breakage: Breakage; readonly verdicts: readonly Verdict[] }>): {
	exitCode: 0 | 1 | 2;
	message: string;
} {
	const all = runs.flatMap((run) => run.verdicts.map((v) => ({ ...v, breakage: run.breakage })));
	const isControl = (v: { breakage: Breakage; checkpoint: string }) => v.breakage === "startup-only" && v.checkpoint === "at startup";
	// A PASS against a broken mod proves the gate cannot fail there; nothing else in the run can excuse it.
	const leaked = all.filter((v) => v.outcome === "PASS" && !isControl(v));
	if (leaked.length > 0) return { exitCode: 1, message: `The gate is broken: ${leaked.map((v) => `${v.checkpoint} (${v.breakage}) passed`).join(", ")}.` };
	const invalid = all.filter((v) => v.outcome === "INVALID").length;
	if (invalid > 0) return { exitCode: 2, message: `${invalid} checkpoint(s) could not be judged; fix the run before trusting the self-test.` };
	const wrong = all.filter((v) => v.outcome !== (isControl(v) ? "PASS" : "FAIL"));
	if (wrong.length > 0) return { exitCode: 1, message: `The gate is broken: ${wrong.map((v) => `${v.checkpoint} (${v.breakage}) ${v.outcome}`).join(", ")}.` };
	return { exitCode: 0, message: "The gate can fail: every checkpoint failed against both broken mods, and the startup-only control passed." };
}

/** The issue `--file-issue` opens for a failing run. */
export function issueBody(version: string, model: string, verdicts: readonly Verdict[], trusted: boolean): string {
	const rows = verdicts.map((v) => `| ${v.checkpoint} | ${v.outcome} | ${v.why || "-"} |`).join("\n");
	const loading = trusted ? "found in a trusted vault, as a user's is (--trusted-dir)" : "loaded with --plugin-dir";
	const flags = trusted ? " --trusted-dir <an empty folder you trusted once in Claude Code>" : "";
	return [
		`The delivery gate failed on Claude Code ${version} (model ${model}, the mod ${loading}): at least one checkpoint did not receive the current session context.`,
		"",
		"| Checkpoint | Outcome | Why |",
		"|---|---|---|",
		rows,
		"",
		"Until this is resolved, do not recommend this Claude Code version. Reproduce with:",
		"",
		"```bash",
		`node --experimental-strip-types .github/scripts/delivery-gate.ts${flags} --model ${model} --self-test`,
		`node --experimental-strip-types .github/scripts/delivery-gate.ts${flags} --model ${model}`,
		"```",
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
	};
	const selfTest = argv.includes("--self-test");
	const trustedDir = flag("--trusted-dir");
	const base = { claude: flag("--claude") ?? "claude", model: flag("--model") ?? "opus", ...(trustedDir ? { trustedDir: resolve(trustedDir) } : {}) };
	const version = spawnSync(base.claude, ["--version"], { encoding: "utf8" }).stdout?.trim() || "unknown version";
	process.on("SIGINT", () => {
		for (const vault of [...fixtures.keys()]) removeFixture(vault);
		process.exit(130);
	});
	const loading = trustedDir ? `found in the trusted folder ${resolve(trustedDir)}` : "loaded with --plugin-dir";
	console.log(`Delivery gate · ${version} · ${base.model} · the mod ${loading}${selfTest ? " · SELF-TEST" : ""}\n`);

	if (selfTest) {
		const runs: Array<{ breakage: Breakage; verdicts: Verdict[] }> = [];
		for (const breakage of ["cut", "startup-only"] as const) {
			const verdicts: Verdict[] = [];
			for (const steps of plan(true)) verdicts.push(...(await runSession(steps, breakage, { ...base, withMod: true })));
			print(` [${breakage}]`, verdicts);
			runs.push({ breakage, verdicts });
		}
		const { exitCode, message } = selfTestOutcome(runs);
		console.log(`\n${message}`);
		process.exitCode = exitCode;
		return;
	}

	const verdicts: Verdict[] = [];
	for (const steps of plan(true)) verdicts.push(...(await runSession(steps, "none", { ...base, withMod: true })));
	for (const steps of plan(false)) verdicts.push(...(await runSession(steps, "none", { ...base, withMod: false })));
	print("", verdicts);
	const invalid = verdicts.filter((v) => v.outcome === "INVALID").length;
	const failed = verdicts.filter((v) => v.outcome === "FAIL").length;
	if (invalid > 0) console.log(`\n${invalid} checkpoint(s) could not be judged.`);
	if (failed > 0) console.log(`\n${failed} checkpoint(s) did not receive the current context: cut, missing, or stale from before a shift.`);
	if (invalid === 0 && failed === 0) console.log("\nEvery checkpoint received the current context, its middle and its end.");
	if (failed > 0 && argv.includes("--file-issue")) {
		const bodyFile = join(mkdtempSync(join(tmpdir(), "om-gate-issue-")), "body.md");
		writeFileSync(bodyFile, issueBody(version, base.model, verdicts, trustedDir !== undefined));
		const filed = spawnSync("gh", ["issue", "create", "--title", `Delivery gate fails on Claude Code ${version}`, "--body-file", bodyFile], {
			cwd: REPO,
			encoding: "utf8",
		});
		console.log(filed.status === 0 ? `\nFiled: ${filed.stdout.trim()}` : `\nCould not file the issue: ${filed.stderr.trim()}`);
	}
	// A FAIL needs nothing else to be judged: it wins over an INVALID elsewhere.
	process.exitCode = failed > 0 ? 1 : invalid > 0 ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
	// Anything that stops the run before a verdict (a fixture check, a missing binary) cannot be judged: exit 2, never 1.
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 2;
	});
}
