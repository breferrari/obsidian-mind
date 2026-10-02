/**
 * readOmMod reads the instruction a Claude Code mod passes on a hook's event
 * (#264). Anything it does not recognise must read as "no instruction", so a
 * typo or a newer mod degrades to the hook's normal behaviour, never to
 * silence.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readOmMod } from "../lib/om-mod.ts";

describe("readOmMod", () => {
	test("each known mode is read back", () => {
		assert.equal(readOmMod({ om_mod: "standdown" }), "standdown");
		assert.equal(readOmMod({ om_mod: "deliver" }), "deliver");
		assert.equal(readOmMod({ om_mod: "report" }), "report");
	});

	test("an event without the field is no instruction", () => {
		assert.equal(readOmMod({ hook_event_name: "Stop", session_id: "s" }), null);
	});

	test("an unknown or mistyped value is no instruction", () => {
		for (const value of ["Standdown", "stand-down", "", "silence", 1, true, null, ["standdown"], { mode: "standdown" }]) {
			assert.equal(readOmMod({ om_mod: value }), null, `om_mod: ${JSON.stringify(value)}`);
		}
	});

	test("input that is not an object is no instruction", () => {
		for (const input of [null, undefined, "standdown", 0, []]) {
			assert.equal(readOmMod(input), null, `input: ${JSON.stringify(input)}`);
		}
	});
});
