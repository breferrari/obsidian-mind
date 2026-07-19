/**
 * Unit tests for the anyWordMatch core matcher: regex-boundary behavior,
 * CJK adjacency, multi-word phrases, empty-input edge cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { anyWordMatch, classify } from "../lib/matcher.ts";

describe("anyWordMatch", () => {
	test("basic match", () => {
		assert.equal(anyWordMatch(["hello"], "hello world"), true);
	});

	test("no match", () => {
		assert.equal(anyWordMatch(["xyz"], "hello world"), false);
	});

	test("boundary prevents substring — 'decision' not in 'predecisioned'", () => {
		assert.equal(anyWordMatch(["decision"], "predecisioned"), false);
	});

	test("boundary prevents prefix — 'shipped' not in 'unshipped'", () => {
		assert.equal(anyWordMatch(["shipped"], "unshipped items"), false);
	});

	test("CJK adjacency — English keyword adjacent to CJK characters matches", () => {
		assert.equal(anyWordMatch(["decision"], "のdecisionについて"), true);
	});

	test("multi-word phrase", () => {
		assert.equal(
			anyWordMatch(["one on one"], "had a one on one with Alice"),
			true,
		);
	});

	test("multi-word no partial — 'one on one' should not match 'one on two'", () => {
		assert.equal(anyWordMatch(["one on one"], "one on two"), false);
	});

	test("CJK pattern match in CJK text", () => {
		assert.equal(anyWordMatch(["決定した"], "チームで決定した"), true);
	});

	test("case sensitive (classify() lowercases first)", () => {
		assert.equal(anyWordMatch(["decision"], "DECISION"), false);
		assert.equal(anyWordMatch(["decision"], "decision"), true);
	});

	// --- Additions beyond Python parity ---

	test("regex special chars in phrase are escaped", () => {
		// '1:1' contains a colon which is not special, but defend against future edits
		assert.equal(anyWordMatch(["1:1"], "had a 1:1 today"), true);
		// Phrases with a dot — should match literally, not any-char
		assert.equal(anyWordMatch(["v1.0"], "released v1.0 today"), true);
		assert.equal(anyWordMatch(["v1.0"], "released v1x0 today"), false);
	});

	test("empty phrase list never matches", () => {
		assert.equal(anyWordMatch([], "anything"), false);
	});

	test("empty text matches no non-empty phrase", () => {
		assert.equal(anyWordMatch(["hello"], ""), false);
	});
});

describe("sub-hints (#111)", () => {
	test("sub-hint fires only alongside its parent signal", () => {
		const out = classify("we decided to reverse course — the old approach is superseded");
		assert.ok(out.some((m) => m.includes("DECISION detected")));
		assert.ok(out.some((m) => m.includes("REVERSAL")));
	});
	test("sub-hint patterns alone (no parent match) emit nothing", () => {
		const out = classify("the migration superseded the old pipeline");
		assert.ok(!out.some((m) => m.includes("REVERSAL")) || out.some((m) => m.includes("DECISION detected")));
	});
	test("parent without sub-hint patterns emits only the parent", () => {
		const out = classify("we decided to ship the feature");
		assert.ok(out.some((m) => m.includes("DECISION detected")));
		assert.ok(!out.some((m) => m.includes("REVERSAL")));
	});
});
