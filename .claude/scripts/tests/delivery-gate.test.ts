/**
 * The delivery gate's judging logic (.github/scripts/delivery-gate.ts, #267).
 * The sessions it runs need a logged-in Claude Code and cost model turns, so
 * they run by hand; what decides PASS or FAIL from their transcripts is here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { answersByTurn, judge, lastLine, plan, quotes } from "../../../.github/scripts/delivery-gate.ts";

const METER = "_context injected: 13.5kB / 20.0kB budget_";

/** A stream-json transcript: one assistant text and one result per turn. */
const transcript = (...answers: string[]) =>
	answers
		.flatMap((text) => [
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
			JSON.stringify({ type: "result", subtype: "success" }),
		])
		.join("\n");

describe("delivery gate", () => {
	test("the mod plan asks at startup, after /compact, after /clear and from a subagent", () => {
		const asked = plan(true).filter((t) => t.name !== "").map((t) => t.name);
		assert.deepEqual(asked, ["at startup", "after /compact", "after /clear", "from a subagent"]);
		assert.deepEqual(plan(true).filter((t) => t.name === "").map((t) => t.prompt), ["/compact", "/clear"]);
		assert.deepEqual(plan(false).map((t) => t.name), ["without the mod, at startup"]);
	});

	test("lastLine is the last non-empty line, trimmed", () => {
		assert.equal(lastLine(`## Session Context\n\n${METER}\n\n`), METER);
		assert.equal(lastLine(""), "");
	});

	test("an answer quotes the line through backticks, quotes and spacing", () => {
		assert.equal(quotes(`The last line is \`${METER}\`.`, METER), true);
		assert.equal(quotes(`"${METER.replace(" / ", "  /  ")}"`, METER), true);
	});

	test("a different, partial or absent line does not count", () => {
		assert.equal(quotes("_context injected: 2.0kB / 9.1kB budget_", METER), false);
		assert.equal(quotes("NONE", METER), false);
		assert.equal(quotes("_context injected: 13.5kB", METER), false);
		assert.equal(quotes("anything", ""), false, "an empty expected line never passes");
	});

	test("answers are split per turn, a compact or clear turn included", () => {
		assert.deepEqual(answersByTurn(transcript("one", "", "three")), ["one", "", "three"]);
	});

	test("judge passes a full session and names each checkpoint", () => {
		const turns = plan(true);
		const answers = answersByTurn(transcript(METER, "", METER, "", METER, METER));
		const verdicts = judge(turns, answers, METER);
		assert.deepEqual(verdicts.map((v) => [v.checkpoint, v.passed]), [
			["at startup", true],
			["after /compact", true],
			["after /clear", true],
			["from a subagent", true],
		]);
	});

	test("judge fails a checkpoint whose answer lost the last line: the case the gate exists for", () => {
		const turns = plan(true);
		const answers = answersByTurn(transcript(METER, "", "NONE: I only see a preview", "", METER, METER));
		const failed = judge(turns, answers, METER).filter((v) => !v.passed).map((v) => v.checkpoint);
		assert.deepEqual(failed, ["after /compact"]);
	});

	test("a session that ended early fails the checkpoints it never reached", () => {
		const verdicts = judge(plan(true), answersByTurn(transcript(METER)), METER);
		assert.deepEqual(verdicts.map((v) => v.passed), [true, false, false, false]);
	});
});
