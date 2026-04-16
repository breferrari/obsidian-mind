/**
 * Data-integrity tests for the SIGNALS table.
 * New coverage — catches table edits that break invariants the runtime assumes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SIGNALS } from "../lib/signals.ts";

describe("SIGNALS table integrity", () => {
	test("every signal has a non-empty name", () => {
		for (const s of SIGNALS) {
			assert.ok(s.name && s.name.length > 0, `signal name empty: ${JSON.stringify(s)}`);
		}
	});

	test("signal names are unique", () => {
		const names = SIGNALS.map((s) => s.name);
		const unique = new Set(names);
		assert.equal(unique.size, names.length, `duplicate names in SIGNALS: ${names}`);
	});

	test("every signal has a non-empty message", () => {
		for (const s of SIGNALS) {
			assert.ok(s.message.length > 0, `empty message for ${s.name}`);
		}
	});

	test("every signal.message contains the signal.name", () => {
		for (const s of SIGNALS) {
			assert.ok(
				s.message.includes(s.name),
				`message for ${s.name} does not reference its name: ${s.message}`,
			);
		}
	});

	test("every signal has at least one pattern", () => {
		for (const s of SIGNALS) {
			assert.ok(s.patterns.length > 0, `no patterns for ${s.name}`);
		}
	});

	test("no pattern is empty or whitespace-only", () => {
		for (const s of SIGNALS) {
			for (const p of s.patterns) {
				assert.ok(p.trim().length > 0, `empty pattern in ${s.name}`);
			}
		}
	});

	test("patterns within a single signal are unique", () => {
		for (const s of SIGNALS) {
			const unique = new Set(s.patterns);
			assert.equal(
				unique.size,
				s.patterns.length,
				`duplicate patterns in ${s.name}`,
			);
		}
	});

	test("known cross-signal overlaps are preserved (WIN ↔ PROJECT UPDATE)", () => {
		const win = SIGNALS.find((s) => s.name === "WIN");
		const pu = SIGNALS.find((s) => s.name === "PROJECT UPDATE");
		assert.ok(win && pu, "WIN and PROJECT UPDATE signals must exist");
		// Intentional overlap: delivery verbs trigger both categories.
		const shared = ["shipped", "launched", "deployed", "released", "completed"];
		for (const verb of shared) {
			assert.ok(
				win.patterns.includes(verb),
				`WIN must include delivery verb ${verb}`,
			);
			assert.ok(
				pu.patterns.includes(verb),
				`PROJECT UPDATE must include delivery verb ${verb}`,
			);
		}
	});

	test("signal count stable (7 categories)", () => {
		assert.equal(SIGNALS.length, 7);
	});
});
