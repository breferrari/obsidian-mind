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

import { findToolMarkup, describeToolMarkup, toolMarkupRefusal } from "../lib/mcp-capture.ts";

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

/**
 * Telling the two shapes apart, because they need OPPOSITE repairs: an embedded
 * hit lost content and the call must be rewritten, a trailing hit left the prose
 * intact and only the tags are wrong. A message that cannot distinguish them
 * sends half its readers to rewrite text that was never at fault.
 */
describe("describing a serialization failure well enough to repair it", () => {
	const PROSE = "Landed the parser rewrite behind a feature flag.";

	test("clean prose does not match, so the absence of a false positive is pinned", () => {
		assert.equal(describeToolMarkup({ title: "parser", summary: PROSE }), null);
	});

	test("closing tags after the content are TRAILING — the prose is not at fault", () => {
		const site = describeToolMarkup({ summary: `${PROSE}</invoke></function_calls>` });
		assert.equal(site?.trailing, true);
		const msg = toolMarkupRefusal(site!);
		assert.match(msg, /Found "<\/invoke" at offset \d+ of "summary"/);
		assert.match(msg, /do not rewrite the prose/);
		assert.ok(!msg.includes("swallowed"), "must not accuse the prose of swallowing a field");
	});

	test("a swallowed following field is EMBEDDED, since content continues past it", () => {
		const summary = [`${PROSE}</summary>`, '<parameter name="changes">["src/parser.ts"]'].join("\n");
		const site = describeToolMarkup({ summary });
		assert.equal(site?.trailing, false);
		const msg = toolMarkupRefusal(site!);
		assert.match(msg, /swallowed the field after it/);
		assert.ok(!msg.includes("do not rewrite the prose"), "embedded content cannot be salvaged");
	});

	test("a list field names the offending item, not just the field", () => {
		const site = describeToolMarkup({ changes: ["fine", '<parameter name="decisions">[]'] });
		assert.equal(site?.item, 2);
		assert.match(toolMarkupRefusal(site!), /of item 2 of "changes"/);
	});

	test("the named field is the field the match sits inside, not the largest one", () => {
		const site = describeToolMarkup({ title: "ok", kind: "</invoke>", summary: "a much longer body" });
		assert.equal(site?.field, "kind");
	});

	test("the reported offset indexes to the reported match", () => {
		const summary = `${PROSE} <function_calls> tail`;
		const site = describeToolMarkup({ summary })!;
		assert.equal(summary.slice(site.offset, site.offset + site.match.length), site.match);
	});
});

/**
 * The refusal has to say what ARRIVED, not only what is wrong.
 *
 * A caller knows what it sent; only the server knows what arrived. When a field
 * has swallowed the ones after it, the gap between those two lists is the whole
 * finding. Without it a caller can comply with the refusal completely, re-send,
 * and fail identically, in a loop where no attempt carries new information.
 */
describe("the refusal names the fields the server received", () => {
	const PROSE = "The gate was measured at the cheapest position, so it passed against the defect.";

	test("a swallowed field is visibly absent from the received list", () => {
		// `changes` was folded into `summary`, so it never arrived as its own key.
		const args = { summary: `${PROSE}</summary>\n<parameter name="changes">["src/a.ts"]` };
		const site = describeToolMarkup(args);
		const msg = toolMarkupRefusal(site!, args);
		assert.match(msg, /Fields received: summary\./);
		assert.ok(!/Fields received:.*changes/.test(msg), "the swallowed field must not appear as received");
	});

	test("the corrupt field's length is reported, but never its value", () => {
		const args = { summary: `${PROSE}</invoke></function_calls>` };
		const site = describeToolMarkup(args);
		const msg = toolMarkupRefusal(site!, args);
		assert.match(msg, /which is \d+ characters long/);
		// The evidence is the key set and a length. Echoing the prose back would
		// make the message longer without making it more diagnosable.
		assert.ok(!msg.includes(PROSE), "the refusal must not echo the caller's prose");
	});

	test("the trailing branch tells the caller to check the list before trusting it", () => {
		const args = { summary: `${PROSE}</invoke></function_calls>`, folder: "brain" };
		const site = describeToolMarkup(args);
		const msg = toolMarkupRefusal(site!, args);
		assert.equal(site?.trailing, true);
		assert.match(msg, /Fields received: summary, folder\./);
		// Trailing does not prove nothing was lost, so the message must not say
		// the prose is fine before the caller has checked which fields arrived.
		assert.match(msg, /CHECK THE FIELD LIST ABOVE FIRST/);
	});

	// #244. The trailing branch used to end "Re-send every field in that case",
	// which is the shape that folded: a caller that complied reproduced the
	// failure and had no second move, so the write tools got abandoned rather
	// than retried. The recovery has to name a DIFFERENT shape than the one that
	// just failed, or the message is a loop.
	test("the trailing branch names a different shape to retry, not the one that folded", () => {
		const args = { summary: `${PROSE}</invoke></function_calls>`, folder: "brain" };
		const site = describeToolMarkup(args);
		const msg = toolMarkupRefusal(site!, args);
		assert.ok(!/Re-send every field/.test(msg), "must not send the caller back into the folding shape");
		assert.match(msg, /do NOT re-send the same shape/);
	});

	// The axis matters as much as the direction. A reproduction folded with
	// FEWER fields and a longer body while a wider, shorter call succeeded, so a
	// caller told only to "drop fields" keeps the long body and keeps failing.
	test("the retry is smaller in total size, not merely in field count", () => {
		const args = { summary: `${PROSE}</invoke>`, folder: "brain" };
		const msg = toolMarkupRefusal(describeToolMarkup(args)!, args);
		assert.match(msg, /SMALLER IN TOTAL SIZE/);
		assert.match(msg, /not merely with fewer fields/);
	});

	// Dropping a field is a trade, not a free retry: the prose can be moved into
	// the body but the FIELD is gone, and a caller taking that blind loses the
	// queryable half without noticing.
	test("the trailing branch prices the field it asks the caller to drop", () => {
		const args = { summary: `${PROSE}</invoke>`, folder: "brain" };
		const msg = toolMarkupRefusal(describeToolMarkup(args)!, args);
		assert.match(msg, /queries on it will not see this record/);
	});

	// The mechanism is not settled, so the message must not promise the retry
	// works — it has been refused at least once. This is the property most
	// likely to be "helpfully" strengthened by a later edit, so it is pinned.
	test("the recovery is offered, never promised", () => {
		const args = { summary: `${PROSE}</invoke>`, folder: "brain" };
		const msg = toolMarkupRefusal(describeToolMarkup(args)!, args);
		assert.ok(
			!/will (succeed|work|fix)|guaranteed|always works/i.test(msg),
			"the narrow retry is a mitigation, not a cure, and must not be stated as one",
		);
	});

	// The other half of the split must not drift while this one changes.
	test("the embedded branch keeps its own repair", () => {
		const args = { summary: `before <parameter name="x">after`, folder: "brain" };
		const site = describeToolMarkup(args);
		assert.equal(site?.trailing, false);
		const msg = toolMarkupRefusal(site!, args);
		assert.match(msg, /swallowed the field after it/);
		assert.ok(!/SMALLER IN TOTAL SIZE/.test(msg), "the narrow retry belongs to the trailing branch only");
	});

	// The optional contract: existing callers pass one argument and still get a
	// usable message, it simply omits the list.
	test("called without args the message is still produced, minus the list", () => {
		const site = describeToolMarkup({ summary: `${PROSE}</invoke>` });
		const msg = toolMarkupRefusal(site!);
		assert.ok(!msg.includes("Fields received"));
		assert.match(msg, /^Refused: "summary" contains tool-call markup/);
	});
});
