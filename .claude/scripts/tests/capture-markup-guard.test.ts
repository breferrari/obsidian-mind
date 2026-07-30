/**
 * The guard against a malformed `record_work` call corrupting a note.
 *
 * Observed for real: a call arrived whose `summary` ended with a closing tag and
 * then carried the whole `changes` array as literal text. It was written
 * verbatim, so the changes section never rendered and nobody noticed until the
 * raw tags showed up in Obsidian days later. Silent vault corruption is the
 * failure being closed here, and every automated signal reported success while
 * it happened.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { findToolMarkup } from "../lib/mcp-capture.ts";

describe("detecting a serialization failure in a capture field", () => {
	test("the exact shape that corrupted a note is caught, and names its field", () => {
		const summary = [
			"Landed the parser rewrite behind a feature flag.</summary>",
			'<parameter name="changes">["src/parser.ts - rewritten."]',
		].join("\n");
		assert.equal(findToolMarkup({ title: "parser", summary }), "summary");
	});

	test("markup inside a LIST field is caught too, since lists are what get folded", () => {
		assert.equal(findToolMarkup({ changes: ["fine", '<parameter name="decisions">[]'] }), "changes");
	});

	test("invoke and function_calls framing is caught, namespaced or not", () => {
		for (const bad of ['<invoke name="x">', "</invoke>", "<function_calls>", "</function_calls>"]) {
			assert.equal(findToolMarkup({ summary: `text ${bad} more` }), "summary", bad);
		}
	});

	// The false positive that would make this guard unusable: notes legitimately
	// use <details><summary> to fold superseded plans, and refusing those would
	// train everyone to work around the guard instead of fixing the call.
	test("a legitimate details/summary block is NOT flagged", () => {
		const summary = "Before:\n<details><summary>Original plan</summary>\n\nold text\n</details>";
		assert.equal(findToolMarkup({ summary }), null);
	});

	test("ordinary prose with angle brackets and comparisons is not flagged", () => {
		const cases = [
			"first paint < 100ms on a large document",
			"use `impl Iterator<Item = Entry>` rather than a Vec",
			"see <https://example.com/spec> for the contract",
			"the parameter name is `path`, not `file`",
		];
		for (const s of cases) assert.equal(findToolMarkup({ summary: s }), null, s);
	});

	test("empty, absent and non-string fields are safe rather than throwing", () => {
		assert.equal(findToolMarkup({}), null);
		assert.equal(findToolMarkup({ summary: undefined, changes: null, kind: 7 }), null);
	});

	test("the first corrupted field is the one reported, so the message is specific", () => {
		const found = findToolMarkup({
			title: "ok",
			summary: '<parameter name="a">',
			changes: ['<parameter name="b">'],
		});
		assert.equal(found, "summary");
	});

	// `remember` shares the write path and the failure mode, and its blast radius
	// is larger: a corrupted work note damages one project's record, while a
	// corrupted memory is served to every other repo through `recall`.
	test("a memory's fields are checked the same way, body included", () => {
		const body = [
			"The retry budget is per-attempt, not per-call.</summary>",
			'<parameter name="verification">["ran the suite"]',
		].join("\n");
		assert.equal(findToolMarkup({ title: "retries", body }), "body");
	});
});
