/**
 * Unit tests for lib/hint-state.ts — the once-per-session hint dedupe
 * state. Pure-function coverage; the entry-script wiring is exercised in
 * classify-message.test.ts via runScript + CLASSIFY_HINT_STATE.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	parseHintState,
	unseen,
	record,
	prune,
	PRUNE_MAX_AGE_MS,
} from "../lib/hint-state.ts";

describe("parseHintState — fail open on anything malformed", () => {
	test("null input → empty state", () => {
		assert.deepEqual(parseHintState(null), {});
	});
	test("malformed JSON → empty state", () => {
		assert.deepEqual(parseHintState("not json {{{"), {});
	});
	test("non-object JSON (array, string, number) → empty state", () => {
		assert.deepEqual(parseHintState("[1,2]"), {});
		assert.deepEqual(parseHintState('"hi"'), {});
		assert.deepEqual(parseHintState("42"), {});
	});
	test("well-formed entries survive, malformed entries are dropped", () => {
		const raw = JSON.stringify({
			good: { seen: ["WIN"], updated: "2026-07-14T08:00:00Z" },
			badSeen: { seen: "WIN", updated: "2026-07-14T08:00:00Z" },
			badUpdated: { seen: ["WIN"], updated: 42 },
			nullEntry: null,
		});
		const state = parseHintState(raw);
		assert.deepEqual(Object.keys(state), ["good"]);
		assert.deepEqual(state["good"]?.seen, ["WIN"]);
	});
	test("non-string members of seen are filtered out", () => {
		const raw = JSON.stringify({
			s: { seen: ["WIN", 42, null, "DECISION"], updated: "2026-07-14T08:00:00Z" },
		});
		assert.deepEqual(parseHintState(raw)["s"]?.seen, ["WIN", "DECISION"]);
	});
});

describe("unseen", () => {
	const state = parseHintState(
		JSON.stringify({
			abc: { seen: ["WIN", "DECISION"], updated: "2026-07-14T08:00:00Z" },
		}),
	);
	test("filters names the session has already fired", () => {
		assert.deepEqual(unseen(state, "abc", ["WIN", "STRATEGY"]), ["STRATEGY"]);
	});
	test("unknown session → everything is unseen", () => {
		assert.deepEqual(unseen(state, "other", ["WIN"]), ["WIN"]);
	});
	test("empty names → empty result", () => {
		assert.deepEqual(unseen(state, "abc", []), []);
	});
});

describe("record", () => {
	test("merges names into the session's seen set, sorted, and stamps updated", () => {
		const s0 = record({}, "abc", ["WIN"], "2026-07-14T08:00:00Z");
		const s1 = record(s0, "abc", ["DECISION", "WIN"], "2026-07-14T09:00:00Z");
		assert.deepEqual(s1["abc"]?.seen, ["DECISION", "WIN"]);
		assert.equal(s1["abc"]?.updated, "2026-07-14T09:00:00Z");
	});
	test("does not mutate the input state", () => {
		const before: ReturnType<typeof parseHintState> = {};
		record(before, "abc", ["WIN"], "2026-07-14T08:00:00Z");
		assert.deepEqual(before, {});
	});
});

describe("prune", () => {
	const NOW = Date.parse("2026-07-14T12:00:00Z");
	test("drops sessions older than maxAge, keeps fresh ones", () => {
		const state = parseHintState(
			JSON.stringify({
				old: { seen: ["WIN"], updated: "2026-07-01T00:00:00Z" },
				fresh: { seen: ["WIN"], updated: "2026-07-14T08:00:00Z" },
			}),
		);
		const pruned = prune(state, NOW, PRUNE_MAX_AGE_MS);
		assert.deepEqual(Object.keys(pruned), ["fresh"]);
	});
	test("unparseable updated stamps are treated as expired", () => {
		const state = parseHintState(
			JSON.stringify({
				junk: { seen: ["WIN"], updated: "not-a-date" },
			}),
		);
		assert.deepEqual(prune(state, NOW), {});
	});
	test("caps total sessions at maxSessions, keeping most recent", () => {
		const entries: Record<string, { seen: string[]; updated: string }> = {};
		for (let i = 0; i < 10; i++) {
			entries[`s${i}`] = {
				seen: ["WIN"],
				updated: new Date(NOW - i * 60_000).toISOString(),
			};
		}
		const pruned = prune(parseHintState(JSON.stringify(entries)), NOW, PRUNE_MAX_AGE_MS, 3);
		assert.deepEqual(Object.keys(pruned).sort(), ["s0", "s1", "s2"]);
	});
});
