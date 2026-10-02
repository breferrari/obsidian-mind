/**
 * The delivery gate's judging logic (.github/scripts/delivery-gate.ts, #267).
 * The sessions it runs need a logged-in Claude Code and cost model turns, so
 * they run by hand; what decides PASS, FAIL or INVALID from their transcripts
 * is here. The events are shaped as Claude Code 2.1.288 emits them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fixtureEnv, judge, lastLine, parseTurns, plan, quotes, type Step } from "../../../.github/scripts/delivery-gate.ts";

const METER = "_context injected: 15.9kB / 20.0kB budget_";

/** Stream-json events, one per line. */
const stream = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
const said = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
const called = (name: string, id = `toolu_${name}`) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name, id }] } });
/** An Agent tool_result as 2.1.288 frames it: preamble, the indented report, then an id and usage footer. */
const handedBack = (text: string, id = "toolu_Agent") => ({
	type: "user",
	message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  ${text}\nagentId: a1b2 (use SendMessage)\n<usage>total_tokens: 100\nduration_ms: 3140</usage>` }] }] },
});
const subagentDone = (toolUses: number) => ({ type: "system", subtype: "task_notification", usage: { tool_uses: toolUses } });
const done = { type: "result", subtype: "success", is_error: false, result: "" };
const compacted = { type: "system", subtype: "compact_boundary" };
const reset = { type: "conversation_reset", trigger: "clear" };

const [startup, continued] = plan(true) as [readonly Step[], readonly Step[]];

/** The continued session, turn by turn, with each turn's events overridable. */
function continuedStream(over: Partial<Record<"warm" | "compact" | "afterCompact" | "clear" | "afterClear" | "subagent", object[]>> = {}): string {
	return stream(
		...(over.warm ?? [said("OK")]), done,
		...(over.compact ?? [compacted]), done,
		...(over.afterCompact ?? [said(METER)]), done,
		...(over.clear ?? [reset]), done,
		...(over.afterClear ?? [said(METER)]), done,
		...(over.subagent ?? [called("Agent"), subagentDone(0), handedBack(METER), said(METER)]), done,
	);
}

const outcomes = (steps: readonly Step[], transcript: string) => judge(steps, parseTurns(transcript), METER).map((v) => [v.checkpoint, v.outcome]);

describe("delivery gate", () => {
	test("startup is a session of its own; the continued one warms up with nothing about the context", () => {
		assert.deepEqual(startup.map((s) => s.name), ["at startup"]);
		assert.deepEqual(continued.map((s) => s.kind), ["warm", "compact", "ask", "clear", "ask", "ask-subagent"]);
		assert.equal(continued[0]!.prompt.includes("_context"), false, "the warm-up must not put the line into the conversation");
		assert.deepEqual(plan(false).flat().map((s) => s.name), ["without the mod, at startup"]);
	});

	test("lastLine and quotes", () => {
		assert.equal(lastLine(`## Session Context\n\n${METER}\n\n`), METER);
		assert.equal(quotes(`The last line is \`${METER}\`.`, METER), true);
		assert.equal(quotes(`"${METER.replace(" / ", "  /  ")}"`, METER), true);
		assert.equal(quotes("_context injected: 2.0kB / 9.1kB budget_", METER), false);
		assert.equal(quotes("_context injected: 15.9kB", METER), false);
		assert.equal(quotes("anything", ""), false, "an empty expected line never passes");
	});

	test("a full, honest run passes every checkpoint", () => {
		assert.deepEqual(outcomes(startup, stream(said(METER), done)), [["at startup", "PASS"]]);
		assert.deepEqual(outcomes(continued, continuedStream()), [
			["after /compact", "PASS"],
			["after /clear", "PASS"],
			["from a subagent", "PASS"],
		]);
	});

	test("a lost line fails: the case the gate exists for", () => {
		assert.deepEqual(outcomes(continued, continuedStream({ afterCompact: [said("NONE")] }))[0], ["after /compact", "FAIL"]);
	});

	test("an answer that used a tool is never a pass: it may have read the context file", () => {
		const verdicts = judge(startup, parseTurns(stream(called("Read"), said(METER), done)), METER);
		assert.equal(verdicts[0]!.outcome, "INVALID");
		assert.match(verdicts[0]!.why, /Read/);
	});

	test("a /compact or /clear that left no event of its own spoils the checkpoint after it", () => {
		assert.deepEqual(outcomes(continued, continuedStream({ compact: [] }))[0], ["after /compact", "INVALID"]);
		assert.deepEqual(outcomes(continued, continuedStream({ clear: [] }))[1], ["after /clear", "INVALID"]);
	});

	test("the subagent checkpoint judges the subagent's own report, never the parent's text", () => {
		// The parent answers itself: no Agent call.
		const selfAnswered = judge(continued, parseTurns(continuedStream({ subagent: [said(METER)] })), METER)[2]!;
		assert.equal(selfAnswered.outcome, "INVALID");
		assert.match(selfAnswered.why, /no subagent answered/);
		// The subagent says NONE and the parent "helpfully" quotes the line anyway.
		assert.deepEqual(outcomes(continued, continuedStream({ subagent: [called("Agent"), subagentDone(0), handedBack("NONE"), said(METER)] }))[2], ["from a subagent", "FAIL"]);
		// What is shown and judged is the subagent's words, not the hand-back frame or its footer.
		const none = judge(continued, parseTurns(continuedStream({ subagent: [called("Agent"), subagentDone(0), handedBack("NONE")] })), METER)[2]!;
		assert.equal(none.answer, "NONE");
		// The subagent read the vault to answer.
		assert.deepEqual(outcomes(continued, continuedStream({ subagent: [called("Agent"), subagentDone(2), handedBack(METER)] }))[2], ["from a subagent", "INVALID"]);
	});

	test("a failed turn or a session that ended early is invalid, never a verdict", () => {
		// Even with the right line already in the text, a turn that ended in an error is not a verdict.
		const failedTurn = judge(startup, parseTurns(stream(said(METER), { type: "result", subtype: "error_max_budget_usd", is_error: true, result: "budget" })), METER)[0]!;
		assert.equal(failedTurn.outcome, "INVALID");
		assert.match(failedTurn.why, /error_max_budget_usd/);
		assert.deepEqual(outcomes(continued, stream(said("OK"), done, compacted, done)), [
			["after /compact", "INVALID"],
			["after /clear", "INVALID"],
			["from a subagent", "INVALID"],
		]);
		assert.deepEqual(outcomes(startup, stream(done)), [["at startup", "INVALID"]], "an empty answer is not a real FAIL");
	});

	test("the fixture's environment drops the caller's Claude Code variables and NODE_PATH, keeps the config dir", () => {
		const env = fixtureEnv("/v", { CLAUDECODE: "1", CLAUDE_PROJECT_DIR: "/x", CLAUDE_CONFIG_DIR: "/c", NODE_PATH: "/n", PATH: "/bin", ANTHROPIC_API_KEY: "k" });
		assert.equal(env.CLAUDECODE, undefined);
		assert.equal(env.CLAUDE_PROJECT_DIR, undefined);
		assert.equal(env.NODE_PATH, undefined);
		assert.equal(env.CLAUDE_CONFIG_DIR, "/c");
		assert.equal(env.PATH, "/bin");
		assert.equal(env.ANTHROPIC_API_KEY, "k");
		assert.match(env.npm_config_prefix ?? "", /\.gate-npm$/);
	});
});
