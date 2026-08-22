/**
 * A refusal has to leave a trace.
 *
 * Every `audit(...)` call sat on a success path, so the log answered "what did
 * this repo read and write" and could not answer "what did it try and fail to
 * do". That is the question a refusal loop needs, and it matters most for the
 * markup refusal, which is NOT self-correcting: its trigger is a serialization
 * failure in the caller's own arguments, so a caller that re-sends the same
 * content hits it again. Such a loop was invisible in the log, and the only
 * artefact left behind was whatever the caller did instead.
 *
 * Driven through the real `tools/call` dispatch with a duck-typed session, so
 * these assert the wiring rather than a helper in isolation. A test that only
 * checked the success path would have passed throughout the old behaviour,
 * which is exactly how the gap survived.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandlers } from "../lib/mcp-server.ts";

import { rmTemp } from "./_helpers.ts";

interface Logged {
	readonly action: string;
	readonly detail: Record<string, unknown>;
}

function harness(vaultRoot: string): { call: (name: string, args: Record<string, unknown>) => Promise<void>; logged: Logged[] } {
	const logged: Logged[] = [];
	const session = {
		roots: [{ uri: `file:///elsewhere/some-project`, name: "some-project" }],
		identityReady: async () => {},
		ok: (_id: unknown, r: unknown) => r,
		error: (_id: unknown, e: unknown) => e,
	};
	const handlers = createHandlers({
		ctx: { vaultRoot, memoryRoot: "memories", qmdIndex: null },
		policy: { roots: ["brain"], never_expose: [] },
		session,
		qmd: () => ({}),
		audit: (action: string, detail: Record<string, unknown> = {}) => logged.push({ action, detail }),
		now: () => new Date(2026, 6, 26),
	} as never);
	const call = async (name: string, args: Record<string, unknown>): Promise<void> => {
		await (handlers as never as Record<string, (id: number, p: unknown) => Promise<unknown>>)["tools/call"]!(
			1,
			{ name, arguments: args },
		);
	};
	return { call, logged };
}

/** The shape a broken serialization actually produces in the field. */
const CORRUPTED = {
	title: "a lesson worth keeping",
	body: 'the prose is fine<parameter name="changes">and then the next field arrived as text',
};

describe("a refused call is auditable", () => {
	test("remember records the refusal, with the field and shape but no prose", async () => {
		const dir = mkdtempSync(join(tmpdir(), "refuse-"));
		try {
			const { call, logged } = harness(dir);
			await call("remember", CORRUPTED);

			const refusals = logged.filter((l) => l.action === "refused");
			assert.equal(refusals.length, 1, "a refusal that logs nothing is a loop nobody can diagnose");
			assert.equal(refusals[0]!.detail["tool"], "remember");
			assert.equal(refusals[0]!.detail["reason"], "tool-call markup");
			// The diagnosable part: which field, and which of the two repairs.
			assert.equal(refusals[0]!.detail["field"], "body");
			assert.equal(typeof refusals[0]!.detail["trailing"], "boolean");
			// The caller's prose must not be copied into the log.
			const serialised = JSON.stringify(refusals[0]);
			assert.ok(!serialised.includes("the prose is fine"), "the log must not become a copy of the call");
		} finally {
			rmTemp(dir);
		}
	});

	test("record_work records its refusal too, named as itself", async () => {
		const dir = mkdtempSync(join(tmpdir(), "refuse-"));
		try {
			const { call, logged } = harness(dir);
			await call("record_work", { ...CORRUPTED, folder: "brain" });

			const refusals = logged.filter((l) => l.action === "refused");
			assert.equal(refusals.length, 1);
			assert.equal(refusals[0]!.detail["tool"], "record_work");
		} finally {
			rmTemp(dir);
		}
	});

	// The other direction, so the guard cannot be satisfied by auditing "refused"
	// unconditionally: a call that is not refused must not log one.
	test("a call that is not refused logs no refusal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "refuse-"));
		try {
			const { call, logged } = harness(dir);
			await call("remember", {
				title: "a clean title stated as a claim",
				body: "A body written for a session that will not have this context, long enough to clear the minimum.",
				confidence: "inferred",
				scope: "general",
			});
			assert.deepEqual(
				logged.filter((l) => l.action === "refused"),
				[],
				"a call that was not refused must not log a refusal",
			);
		} finally {
			rmTemp(dir);
		}
	});
});
