/**
 * The delivery gate's judging logic (.github/scripts/delivery-gate.ts, #267).
 * The sessions it runs need a logged-in Claude Code and cost model turns, so
 * they run by hand; what decides PASS, FAIL or INVALID from their transcripts
 * is here. Every event is shaped as Claude Code 2.1.288 emits it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFixture,
	countResults,
	carries,
	expectationTracker,
	expectedOf,
	fixtureEnv,
	issueBody,
	isCheckpoint,
	judge,
	meterSize,
	shifts,
	lastLine,
	parseTurns,
	plan,
	quotes,
	selfTestOutcome,
	sessionDirs,
	subagentReport,
	SUBAGENT_TASK,
	type Step,
	type Verdict,
} from "../../../.github/scripts/delivery-gate.ts";

const METER = "_context injected: 15.9kB / 20.0kB budget_";

/** Stream-json events, one per line. */
const stream = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
const said = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
const called = (name: string, input: object = {}, id = `toolu_${name}`) => ({
	type: "assistant",
	parent_tool_use_id: null,
	message: { content: [{ type: "tool_use", name, id, input }] },
});
const agentCall = (prompt = SUBAGENT_TASK, subagent_type = "general-purpose") => called("Agent", { prompt, subagent_type });
/** An Agent tool_result: the framed text for the model, plus the raw result Claude Code reports beside it. */
const handedBack = (report: string, extra: { totalToolUseCount?: number; agentType?: string } = { totalToolUseCount: 0, agentType: "general-purpose" }) => ({
	type: "user",
	message: {
		content: [
			{
				type: "tool_result",
				tool_use_id: "toolu_Agent",
				content: [{ type: "text", text: `[Subagent hand-back] The report follows:\n  ${report}\nagentId: a1 (use SendMessage)` }],
			},
		],
	},
	tool_use_result: { status: "completed", content: [{ type: "text", text: report }], ...extra },
});
const hookPrinted = (stdout: string) => ({ type: "system", subtype: "hook_response", hook_event: "SessionStart", stdout });
const stoodDown = hookPrinted("");
const summary = (text: string) => ({ type: "user", isSynthetic: true, message: { role: "user", content: text } });
const done = { type: "result", subtype: "success", is_error: false, result: "" };
const compacted = { type: "system", subtype: "compact_boundary" };
const reset = { type: "conversation_reset", trigger: "clear" };

const [startup, continued] = plan(true) as [readonly Step[], readonly Step[]];
const MOD = { withMod: true };

type Part = "warm" | "compact" | "afterCompact" | "clear" | "subagent" | "clearAgain" | "afterClear";
/** The continued session, turn by turn, each turn's events overridable. The mod stood the hook down at every start. */
function continuedStream(over: Partial<Record<Part, object[]>> = {}): string {
	return stream(
		stoodDown,
		...(over.warm ?? [said("OK")]),
		done,
		...(over.compact ?? [stoodDown, compacted, summary("The user asked for OK.")]),
		done,
		...(over.afterCompact ?? [said(METER)]),
		done,
		...(over.clear ?? [stoodDown, reset]),
		done,
		...(over.subagent ?? [agentCall(), handedBack(METER), said(METER)]),
		done,
		...(over.clearAgain ?? [stoodDown, reset]),
		done,
		...(over.afterClear ?? [said(METER)]),
		done,
	);
}

const run = (steps: readonly Step[], transcript: string, options = MOD) => judge(steps, parseTurns(transcript), METER, options);
const outcomes = (steps: readonly Step[], transcript: string, options = MOD) => run(steps, transcript, options).map((v) => [v.checkpoint, v.outcome]);
const subagentVerdict = (events: object[]) => run(continued, continuedStream({ subagent: events })).find((v) => v.checkpoint === "from a subagent")!;

describe("delivery gate: plan and matching", () => {
	test("startup is a session of its own; the subagent is asked straight after /clear, before the line is quoted again", () => {
		assert.deepEqual(
			startup.map((s) => s.name),
			["at startup"],
		);
		assert.deepEqual(
			continued.map((s) => s.kind),
			["warm", "compact", "ask", "clear", "ask-subagent", "clear", "ask"],
		);
		assert.deepEqual(
			continued.filter(shifts).map((s) => s.kind),
			["compact", "clear", "clear"],
			"every compact and clear shifts the fixture first",
		);
		assert.deepEqual(
			continued.filter(isCheckpoint).map((s) => s.name),
			["after /compact", "from a subagent", "after /clear"],
			"only the questions are judged",
		);
		assert.equal(continued[5]!.kind, "clear", "the subagent's answer is cleared away before the main loop is asked again");
		assert.equal(continued[0]!.prompt.includes("_context"), false, "the warm-up must not put the line into the conversation");
		assert.deepEqual(
			plan(false)
				.flat()
				.filter(isCheckpoint)
				.map((s) => s.name),
			["without the mod, at startup", "without the mod, after /compact", "without the mod, after /clear"],
		);
		assert.equal(
			plan(false)
				.flat()
				.some((s) => s.kind === "ask-subagent"),
			false,
			"a subagent gets no hook output by design: nothing to ask it without the mod",
		);
	});

	test("lastLine and quotes", () => {
		assert.equal(lastLine(`## Session Context\n\n${METER}\n\n`), METER);
		assert.equal(quotes(`The last line is \`${METER}\`.`, METER), true);
		assert.equal(quotes(`"${METER.replace(" / ", "  /  ")}"`, METER), true);
		assert.equal(quotes("context injected: 15.9kB / 20.0kB budget", METER), true, "dropped emphasis marks still match");
		assert.equal(quotes("_context injected: 2.0kB / 9.1kB budget_", METER), false);
		assert.equal(quotes("_context injected: 15.9kB", METER), false);
		assert.equal(quotes("anything", ""), false, "an empty expected line never passes");
	});

	test("meterSize reads the delivered size off the meter line, not the budget", () => {
		assert.equal(meterSize(METER), "15.9");
		assert.equal(meterSize("_context injected: 0.6kB / 9.1kB budget — collapsed: Vault File Listing_"), "0.6");
		assert.equal(meterSize("NONE"), undefined);
	});

	test("carries finds the delivered size in any wording, or the marker, never the budget", () => {
		const want = { line: METER, marker: "GATE-MARK-0A1B2C3D" };
		assert.equal(carries(`The meter read ${METER}`, want), true);
		for (const text of ["it was 15.9kB", "15.9 KB of context", "about 15.9 kilobytes", "context injected 15.9 / 20.0"])
			assert.equal(carries(text, want), true, text);
		assert.equal(carries("the note held GATE-MARK-0A1B2C3D", want), true, "the marker alone is enough to answer");
		assert.equal(carries("a 20.0kB budget", want), false, "the budget is the same before and after a shift");
		assert.equal(carries("115.9kB or 15.95", want), false, "a longer number is a different number");
		assert.equal(carries("an older GATE-MARK-FFFFFFFF", want), false, "another marker is not this one");
	});

	test("a checkpoint needs both the last line and the marker", () => {
		const want = { line: METER, marker: "GATE-MARK-0A1B2C3D" };
		const turns = (text: string) => parseTurns(stream(stoodDown, said(text), done));
		assert.equal(judge(startup, turns(`${METER}\nGATE-MARK-0A1B2C3D`), want, MOD)[0]!.outcome, "PASS");
		const tailOnly = judge(startup, turns(`${METER}\nNONE`), want, MOD)[0]!;
		assert.equal(tailOnly.outcome, "FAIL", "a cut that keeps the tail loses the middle");
		assert.match(tailOnly.why, /middle of the context did not arrive/);
		assert.equal(judge(startup, turns("NONE\nGATE-MARK-0A1B2C3D"), want, MOD)[0]!.outcome, "FAIL", "a cut that keeps the middle loses the tail");
	});

	test("each shift's own line: quoting a neighbour's is a stale FAIL", () => {
		const L1 = "_context injected: 15.5kB / 20.0kB budget_";
		const L2 = "_context injected: 15.9kB / 20.0kB budget_";
		const L3 = "_context injected: 16.2kB / 20.0kB budget_";
		const lines = [METER, L1, L1, L2, L2, L3, L3];
		const honest = parseTurns(continuedStream({ afterCompact: [said(L1)], subagent: [agentCall(), handedBack(L2)], afterClear: [said(L3)] }));
		assert.deepEqual(
			judge(continued, honest, lines, MOD).map((v) => v.outcome),
			["PASS", "PASS", "PASS"],
		);
		// After the second /clear the main loop quotes the subagent's line from the conversation.
		const echoed = judge(
			continued,
			parseTurns(continuedStream({ afterCompact: [said(L1)], subagent: [agentCall(), handedBack(L2)], afterClear: [said(L2)] })),
			lines,
			MOD,
		)[2]!;
		assert.equal(echoed.outcome, "FAIL");
		assert.match(echoed.why, /stale/);
	});

	test("the tracker shifts exactly at the steps that shift, and only when they are reached", () => {
		const calls: number[] = [];
		const lineFor = expectationTracker({ line: "L0", marker: null }, (n) => {
			calls.push(n);
			return { line: `L${n}`, marker: null };
		});
		const lines: string[] = [];
		for (const step of continued) {
			lines.push(lineFor(step).line);
			if (step.kind === "compact") assert.deepEqual(calls, [1], "the first shift lands with the /compact, not before");
		}
		assert.deepEqual(lines, ["L0", "L1", "L1", "L2", "L2", "L3", "L3"]);
		assert.deepEqual(calls, [1, 2, 3]);
	});

	test("each step is judged against its own line when the fixture shifts mid-session", () => {
		const LATER = "_context injected: 16.4kB / 20.0kB budget_";
		const lines = continued.map((_, i) => (i < 1 ? METER : LATER));
		// The compaction summary repeats the old size: harmless, the new line is what must arrive.
		const turns = parseTurns(
			continuedStream({
				compact: [stoodDown, compacted, summary(`It ended at ${METER}.`)],
				afterCompact: [said(LATER)],
				subagent: [agentCall(), handedBack(LATER)],
				afterClear: [said(LATER)],
			}),
		);
		assert.deepEqual(
			judge(continued, turns, lines, MOD).map((v) => v.outcome),
			["PASS", "PASS", "PASS"],
		);
		// Quoting the old line after a shift is a FAIL: it came from memory, not from delivery.
		const stale = parseTurns(continuedStream({ afterCompact: [said(METER)], subagent: [agentCall(), handedBack(LATER)], afterClear: [said(LATER)] }));
		assert.equal(judge(continued, stale, lines, MOD)[0]!.outcome, "FAIL");
	});

	test("the framed report is cut at a footer at the start of a line, not an indented one inside the report", () => {
		assert.equal(subagentReport("x The report follows:\n  NONE\nagentId: a1"), "NONE");
		assert.equal(subagentReport("The report follows:\n  line one\n  agentId: quoted\nagentId: a1"), "line one\n  agentId: quoted");
	});
});

describe("delivery gate: verdicts", () => {
	test("a full, honest run passes every checkpoint", () => {
		assert.deepEqual(outcomes(startup, stream(stoodDown, said(METER), done)), [["at startup", "PASS"]]);
		assert.deepEqual(outcomes(continued, continuedStream()), [
			["after /compact", "PASS"],
			["from a subagent", "PASS"],
			["after /clear", "PASS"],
		]);
		assert.deepEqual(outcomes(startup, stream(hookPrinted("## Session Context ..."), said(METER), done), { withMod: false }), [["at startup", "PASS"]]);
	});

	test("a lost line fails: the case the gate exists for", () => {
		assert.deepEqual(outcomes(continued, continuedStream({ afterCompact: [said("NONE")] }))[0], ["after /compact", "FAIL"]);
	});

	test("an answer that used a tool is never a pass: it may have read the context file", () => {
		const v = run(startup, stream(stoodDown, called("Read"), said(METER), done))[0]!;
		assert.equal(v.outcome, "INVALID");
		assert.match(v.why, /Read/);
	});

	test("a /compact or /clear that left no event of its own spoils the checkpoint after it", () => {
		assert.match(run(continued, continuedStream({ compact: [stoodDown] }))[0]!.why, /compact_boundary/);
		assert.match(run(continued, continuedStream({ clear: [stoodDown] }))[1]!.why, /conversation_reset/);
	});

	test("a /compact summary that carried the line spoils the checkpoint after it", () => {
		const v = run(continued, continuedStream({ compact: [stoodDown, compacted, summary(`The context ended with ${METER}.`)] }))[0]!;
		assert.equal(v.outcome, "INVALID");
		assert.match(v.why, /summary itself carried/);
	});

	test("with the mod, a settings hook that printed the context means the mod did not deliver it", () => {
		const v = run(startup, stream(hookPrinted("## Session Context ..."), said(METER), done))[0]!;
		assert.equal(v.outcome, "INVALID");
		assert.match(v.why, /settings hook printed/);
	});

	test("with the mod, a settings hook that printed only at the compaction still spoils the session", () => {
		const verdicts = run(continued, continuedStream({ compact: [hookPrinted("## Session Context ..."), compacted, summary("OK.")] }));
		assert.deepEqual(
			verdicts.map((v) => v.outcome),
			["INVALID", "INVALID", "INVALID"],
		);
		for (const v of verdicts) assert.match(v.why, /settings hook printed/);
	});

	test("a summary that carried the line in other words spoils the checkpoint after it", () => {
		const v = run(continued, continuedStream({ compact: [stoodDown, compacted, summary("The context said 15.9kB of a 20.0kB budget.")] }))[0]!;
		assert.match(v.why, /summary itself carried/);
	});

	test("a broken preparing step spoils only the checkpoint right after it", () => {
		assert.deepEqual(
			run(continued, continuedStream({ compact: [stoodDown, compacted] })).map((v) => v.outcome),
			["INVALID", "PASS", "PASS"],
		);
	});

	test("a summary sent as blocks is still read; a compaction with no readable summary is invalid", () => {
		const blocks = { type: "user", isSynthetic: true, message: { role: "user", content: [{ type: "text", text: `It ended at ${METER}.` }] } };
		assert.match(run(continued, continuedStream({ compact: [stoodDown, compacted, blocks] }))[0]!.why, /summary itself carried/);
		assert.match(run(continued, continuedStream({ compact: [stoodDown, compacted] }))[0]!.why, /could not be read/);
	});

	test("a turn nobody sent spoils the session, even when it ended normally", () => {
		const extra = continuedStream({ compact: [stoodDown, compacted, summary("OK."), done, said("an unsent turn")] });
		for (const v of run(continued, extra)) {
			assert.equal(v.outcome, "INVALID");
			assert.match(v.why, /turn nobody sent/);
		}
	});

	test("without the mod, a settings hook that printed nothing means nothing was delivered", () => {
		const v = run(startup, stream(stoodDown, said(METER), done), { withMod: false })[0]!;
		assert.equal(v.outcome, "INVALID");
		assert.match(v.why, /printed nothing/);
	});
});

describe("delivery gate: the subagent checkpoint", () => {
	test("judges the subagent's own report, never the parent's text", () => {
		assert.equal(subagentVerdict([agentCall(), handedBack("NONE"), said(METER)]).outcome, "FAIL");
		assert.equal(subagentVerdict([agentCall(), handedBack("NONE"), said(METER)]).answer, "NONE");
	});

	test("the raw result is preferred over the framed text, which a new frame could change", () => {
		const reframed = {
			type: "user",
			message: {
				content: [
					{ type: "tool_result", tool_use_id: "toolu_Agent", content: [{ type: "text", text: `A new frame quoting the parent's context: ${METER}\n\nNONE` }] },
				],
			},
			tool_use_result: { status: "completed", content: [{ type: "text", text: "NONE" }], totalToolUseCount: 0, agentType: "general-purpose" },
		};
		assert.equal(subagentVerdict([agentCall(), reframed]).outcome, "FAIL");
	});

	test("the parent answering itself is invalid", () => {
		assert.match(subagentVerdict([said(METER)]).why, /no single subagent/);
	});

	test("the parent using another tool is invalid", () => {
		assert.match(subagentVerdict([called("Read"), agentCall(), handedBack(METER)]).why, /main loop used tools/);
	});

	test("a subagent of another type is invalid: it may not receive instruction files, or may inherit the conversation", () => {
		assert.match(
			subagentVerdict([agentCall(SUBAGENT_TASK, "Explore"), handedBack(METER, { totalToolUseCount: 0, agentType: "Explore" })]).why,
			/not general-purpose/,
		);
	});

	test("a subagent handed the line in its prompt is invalid", () => {
		assert.match(subagentVerdict([agentCall(`${SUBAGENT_TASK} The line is ${METER}.`), handedBack(METER)]).why, /handed the line/);
		assert.match(
			subagentVerdict([agentCall(`${SUBAGENT_TASK} Hint: it mentions 15.9kB.`), handedBack(METER)]).why,
			/handed the line/,
			"a size alone is enough to rebuild it",
		);
		const described = called("Agent", { prompt: SUBAGENT_TASK, description: "Find 15.9kB", subagent_type: "general-purpose" });
		assert.match(subagentVerdict([described, handedBack(METER)]).why, /handed the line/, "the description is handed over too");
	});

	test("a subagent that used tools, or whose tool count was not reported, is invalid", () => {
		assert.match(subagentVerdict([agentCall(), handedBack(METER, { totalToolUseCount: 2, agentType: "general-purpose" })]).why, /used 2 tool/);
		assert.match(subagentVerdict([agentCall(), handedBack(METER, { agentType: "general-purpose" })]).why, /not reported/);
		const inline = {
			type: "assistant",
			parent_tool_use_id: "toolu_Agent",
			message: {
				content: [
					{ type: "tool_use", name: "Read", id: "x" },
					{ type: "text", text: METER },
				],
			},
		};
		const v = subagentVerdict([agentCall(), inline, handedBack(METER)]);
		assert.match(v.why, /used 1 tool/, "a subagent's inline tool use counts against it");
	});

	test("a subagent's inline text is not the parent's answer", () => {
		const inline = { type: "assistant", parent_tool_use_id: "toolu_Agent", message: { content: [{ type: "text", text: METER }] } };
		const turns = parseTurns(stream(agentCall(), inline, handedBack("NONE"), done));
		assert.equal(turns[0]!.text, "");
	});
});

describe("delivery gate: sessions that did not run as planned", () => {
	test("a failed turn is not a verdict, even with the right line in its text", () => {
		const v = run(startup, stream(stoodDown, said(METER), { type: "result", subtype: "error_max_budget_usd", is_error: true, result: "budget" }))[0]!;
		assert.equal(v.outcome, "INVALID");
		assert.match(v.why, /error_max_budget_usd/);
	});

	test("checkpoints a session never reached say why it stopped", () => {
		const cut = stream(stoodDown, said("OK"), done, stoodDown, compacted, summary("OK."), done);
		assert.match(judge(continued, parseTurns(cut), METER, { withMod: true, ending: "timeout" })[0]!.why, /timed out/);
		assert.match(judge(continued, parseTurns(cut), METER, { withMod: true, ending: "extra-turn" })[0]!.why, /turn nobody sent/);
		assert.match(judge(continued, parseTurns(cut), METER, { withMod: true })[0]!.why, /ended before/);
	});

	test("an empty answer is not a real FAIL", () => {
		assert.deepEqual(outcomes(startup, stream(stoodDown, done)), [["at startup", "INVALID"]]);
	});
});

describe("delivery gate: self-test and environment", () => {
	const v = (checkpoint: string, outcome: Verdict["outcome"]): Verdict => ({ checkpoint, expected: METER, answer: "", outcome, why: "" });
	const broken = (startupOutcome: Verdict["outcome"]) => [
		{ breakage: "cut" as const, verdicts: [v("at startup", "FAIL"), v("after /compact", "FAIL")] },
		{ breakage: "startup-only" as const, verdicts: [v("at startup", startupOutcome), v("after /compact", "FAIL")] },
	];

	test("the self-test passes only when every checkpoint fails and the startup-only control passes", () => {
		assert.equal(selfTestOutcome(broken("PASS")).exitCode, 0);
		assert.equal(selfTestOutcome(broken("FAIL")).exitCode, 1, "a control that failed means that copy never delivered");
		const leaky = broken("PASS");
		leaky[0]!.verdicts[1] = v("after /compact", "PASS");
		assert.equal(selfTestOutcome(leaky).exitCode, 1);
		const leakedAndInvalid = broken("PASS");
		leakedAndInvalid[0]!.verdicts[1] = v("after /compact", "PASS");
		leakedAndInvalid[1]!.verdicts[1] = v("after /compact", "INVALID");
		assert.equal(selfTestOutcome(leakedAndInvalid).exitCode, 1, "a PASS against a broken mod is not excused by an INVALID elsewhere");
		const invalid = broken("PASS");
		invalid[1]!.verdicts[1] = v("after /compact", "INVALID");
		assert.equal(selfTestOutcome(invalid).exitCode, 2);
	});

	test("the fixture's environment keeps what a session needs and drops the caller's session variables", () => {
		const env = fixtureEnv("/v", {
			CLAUDECODE: "1",
			CLAUDE_PROJECT_DIR: "/x",
			CLAUDE_CONFIG_DIR: "/c",
			CLAUDE_CODE_GIT_BASH_PATH: "/g",
			CLAUDE_CODE_OAUTH_TOKEN: "t",
			NODE_PATH: "/n",
			PATH: "/bin",
			ANTHROPIC_API_KEY: "k",
		});
		assert.equal(env.CLAUDECODE, undefined);
		assert.equal(env.CLAUDE_PROJECT_DIR, undefined);
		assert.equal(env.NODE_PATH, undefined);
		assert.equal(env.CLAUDE_CONFIG_DIR, "/c");
		assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, "/g");
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "t");
		assert.equal(env.PATH, "/bin");
		assert.equal(env.ANTHROPIC_API_KEY, "k");
		assert.match(env.npm_config_prefix ?? "", /\.gate-npm$/);
	});

	test("results are counted as their lines complete, once each, even split across chunks", () => {
		const result = JSON.stringify({ type: "result", subtype: "success" });
		const half = Math.floor(result.length / 2);
		let state = countResults("", `${JSON.stringify({ type: "assistant" })}\n${result.slice(0, half)}`);
		assert.deepEqual(state.results, 0, "half a line is not counted yet");
		state = countResults(state.pending, `${result.slice(half)}\n${result}\n`);
		assert.equal(state.results, 2);
		assert.equal(state.pending, "");
		assert.equal(countResults("", `${JSON.stringify({ type: "user", message: { content: '"type":"result"' } })}\n`).results, 0, "the words inside a message are not an event");
	});

	test("a trusted folder is used only when empty or the gate's own", () => {
		const foreign = mkdtempSync(join(tmpdir(), "gate-foreign-"));
		try {
			writeFileSync(join(foreign, "notes.md"), "mine");
			assert.throws(() => buildFixture("none", { trustedDir: foreign, notes: 0 }), /not empty and not the gate's own/);
			assert.equal(readFileSync(join(foreign, "notes.md"), "utf8"), "mine", "nothing of the owner's is touched");
		} finally {
			rmSync(foreign, { recursive: true, force: true });
		}
	});

	test("expectedOf takes the last line, and the marker only when the context carries it", () => {
		assert.deepEqual(expectedOf(`body GATE-MARK-1\n${METER}\n`, "GATE-MARK-1"), { line: METER, marker: "GATE-MARK-1" });
		assert.deepEqual(expectedOf(`collapsed\n${METER}\n`, "GATE-MARK-1"), { line: METER, marker: null });
	});

	test("the issue for a failing run names the version and every checkpoint", () => {
		const body = issueBody("2.1.300 (Claude Code)", "opus", [
			{ checkpoint: "at startup", expected: METER, answer: "", outcome: "PASS", why: "" },
			{ checkpoint: "after /compact", expected: METER, answer: "", outcome: "FAIL", why: "stale" },
		], true);
		assert.match(body, /Claude Code 2\.1\.300/);
		assert.match(body, /\| after \/compact \| FAIL \| stale \|/);
		assert.match(body, /do not recommend this Claude Code version/);
		assert.match(body, /found in a trusted vault/, "it says which loading path failed");
		assert.match(body, /delivery-gate\.ts --trusted-dir .* --model opus --self-test/, "it reproduces with the same flags");
		assert.doesNotMatch(issueBody("v", "opus", [], false), /--trusted-dir/, "a --plugin-dir run is reproduced without it");
	});

	test("cleanup targets only a fixture's own session folders", () => {
		const dirs = sessionDirs("C:\\Temp\\om-delivery-gate-AbC123", { CLAUDE_CONFIG_DIR: "/cfg" });
		assert.equal(dirs.length, 2);
		assert.ok(dirs[0]!.endsWith("C--Temp-om-delivery-gate-AbC123"));
		assert.ok(dirs[0]!.includes("projects"));
		assert.deepEqual(
			sessionDirs("/home/me/vault", {}, (p) => p),
			[],
			"never a folder that is not a gate fixture's",
		);
		const both = sessionDirs("/var/folders/om-delivery-gate-x", { CLAUDE_CONFIG_DIR: "/cfg" }, () => "/private/var/folders/om-delivery-gate-x");
		assert.equal(both.length, 4, "the created and the resolved path are both slugged");
	});
});
