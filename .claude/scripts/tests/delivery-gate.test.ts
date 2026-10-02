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
const handedBack = (text: string, id = "toolu_Agent") => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: `[Subagent hand-back] The report follows:\n  ${text}` }] }] } });
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
		assert.deepEqual(outcomes(continued, continuedStream({ subagent: [said(METER)] }))[2], ["from a subagent", "INVALID"]);
		// The subagent says NONE and the parent "helpfully" quotes the line anyway.
		assert.deepEqual(outcomes(continued, continuedStream({ subagent: [called("Agent"), subagentDone(0), handedBack("NONE"), said(METER)] }))[2], ["from a subagent", "FAIL"]);
		// The subagent read the vault to answer.
		assert.deepEqual(outcomes(continued, continuedStream({ subagent: [called("Agent"), subagentDone(2), handedBack(METER)] }))[2], ["from a subagent", "INVALID"]);
	});

	test("a failed turn or a session that ended early is invalid, never a verdict", () => {
		assert.deepEqual(outcomes(startup, stream({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "budget" })), [["at startup", "INVALID"]]);
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
