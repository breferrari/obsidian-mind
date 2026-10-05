/**
 * Every tool's schema `required` fields are enforced in the dispatcher.
 *
 * `required` is advisory: a client that does not validate against the schema
 * sends the call anyway, and each handler used to meet the gap its own way —
 * `record_work` wrote `<date>-undefined.md`, `remember` accepted a title of
 * `42`, `search`/`expand`/`reason` ran on "". The cases below are generated
 * from TOOLS, the list `tools/list` serves, so a new tool or a new required
 * field is covered without a new test.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandlers, missingRequired } from "../lib/mcp-server.ts";
import { TOOLS } from "../lib/mcp-tools.ts";

import { rmTemp } from "./_helpers.ts";

interface Logged {
	readonly action: string;
	readonly detail: Record<string, unknown>;
}

function harness(vaultRoot: string) {
	const logged: Logged[] = [];
	const session = {
		roots: [{ uri: "file:///elsewhere/some-project", name: "some-project" }],
		identityReady: async () => {},
		ok: (_id: unknown, r: unknown) => r,
		error: (_id: unknown, e: unknown) => e,
		fail: (_id: unknown, e: unknown) => e,
	};
	const handlers = createHandlers({
		ctx: { vaultRoot, memoryRoot: "memories", qmdIndex: null },
		policy: { roots: ["brain"], neverExpose: new Set(), source: "manifest", memoryRoot: "memories" },
		session,
		qmd: () => ({}),
		audit: (action: string, detail: Record<string, unknown> = {}) => logged.push({ action, detail }),
		now: () => new Date(2026, 6, 26),
		reindex: () => true,
	} as never);
	const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
		const r = (await (handlers as never as Record<string, (id: number, p: unknown) => Promise<unknown>>)[
			"tools/call"
		]!(1, { name, arguments: args })) as { content?: { text?: string }[] };
		return r?.content?.[0]?.text ?? JSON.stringify(r);
	};
	return { call, logged };
}

type Schema = { required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[] }> };

/** A call that satisfies every required field of `tool`'s schema. */
function completeArgs(schema: Schema): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const f of schema.required ?? []) {
		const p = schema.properties?.[f];
		args[f] = p?.enum?.[0] ?? (p?.type === "string" ? `a ${f}` : 1);
	}
	return args;
}

const REFUSAL = /^Not (recorded|remembered|run): `([^`]+)` is required and must be a non-empty string\.$/;

const withRequired = TOOLS.filter((t) => ((t.inputSchema as Schema).required ?? []).length > 0);

describe("the dispatcher refuses a call missing a required field", () => {
	test("the tools that declare required fields are all covered", () => {
		assert.deepEqual(
			withRequired.map((t) => t.name).sort(),
			["expand", "reason", "record_work", "remember", "search"],
		);
	});

	for (const tool of withRequired) {
		const schema = tool.inputSchema as Schema;
		for (const field of schema.required ?? []) {
			const bad: [string, unknown][] = [
				["absent", undefined],
				["empty", ""],
				["whitespace", "   "],
				["non-string", 42],
			];
			for (const [label, value] of bad) {
				test(`${tool.name} with ${field} ${label} → refused, audited, handler not reached`, async () => {
					const dir = mkdtempSync(join(tmpdir(), "mcp-required-"));
					try {
						mkdirSync(join(dir, "brain"));
						const { call, logged } = harness(dir);
						const args = completeArgs(schema);
						if (value === undefined) delete args[field];
						else args[field] = value;
						const out = await call(tool.name, args);
						const m = REFUSAL.exec(out);
						assert.ok(m, `expected the dispatcher's refusal, got: ${out}`);
						assert.equal(m[2], field);
						const refusals = logged.filter((l) => l.action === "refused");
						assert.equal(refusals.length, 1);
						assert.deepEqual(refusals[0]!.detail, { tool: tool.name, reason: `missing ${field}` });
					} finally {
						rmTemp(dir);
					}
				});
			}
		}
	}

	test("remember with a non-string title is refused, not stringified", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-required-"));
		try {
			const { call } = harness(dir);
			const out = await call("remember", { title: 42, body: "x".repeat(200), confidence: "verified" });
			assert.equal(out, "Not remembered: `title` is required and must be a non-empty string.");
		} finally {
			rmTemp(dir);
		}
	});

	test("a call with every required field present passes the check", () => {
		for (const tool of withRequired) {
			assert.equal(missingRequired(tool.name, completeArgs(tool.inputSchema as Schema)), null, tool.name);
		}
	});

	test("an unknown tool or one with no required list is not checked here", () => {
		assert.equal(missingRequired("health", {}), null);
		assert.equal(missingRequired("no-such-tool", {}), null);
		assert.equal(missingRequired(undefined, {}), null);
	});
});
