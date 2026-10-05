/**
 * `record_work` must refuse a call without `title` or `summary`.
 *
 * Both are `required` in the tool schema, but that is advisory: a client that
 * does not validate against it sends the call anyway. A missing title used to
 * become a `<date>-undefined.md` note with an empty H1 and no alias, returned
 * as "Recorded:". Driven through the real `tools/call` dispatch.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandlers } from "../lib/mcp-server.ts";

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
	const call = async (args: Record<string, unknown>): Promise<string> => {
		const r = (await (handlers as never as Record<string, (id: number, p: unknown) => Promise<unknown>>)[
			"tools/call"
		]!(1, { name: "record_work", arguments: args })) as { content?: { text?: string }[] };
		return r?.content?.[0]?.text ?? JSON.stringify(r);
	};
	return { call, logged };
}

/** Every .md file under the vault, relative — what a call left behind. */
function written(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf-8" }).filter((f) => f.endsWith(".md"));
}

const GOOD = { title: "Add the archive command", summary: "What changed and why.", folder: "brain" };

describe("record_work refuses a call missing a required field", () => {
	const cases: [string, Record<string, unknown>, string][] = [
		["no title", { summary: GOOD.summary, folder: "brain" }, "title"],
		["empty title", { ...GOOD, title: "" }, "title"],
		["whitespace title", { ...GOOD, title: "   " }, "title"],
		["non-string title", { ...GOOD, title: 42 }, "title"],
		["no summary", { title: GOOD.title, folder: "brain" }, "summary"],
	];

	for (const [label, args, field] of cases) {
		test(`${label} → Not recorded, nothing written, refusal audited`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "rw-required-"));
			try {
				mkdirSync(join(dir, "brain"));
				const { call, logged } = harness(dir);
				const text = await call(args);
				assert.match(text, new RegExp(`^Not recorded: \`${field}\` is required`));
				assert.deepEqual(written(dir), []);
				const refusals = logged.filter((l) => l.action === "refused");
				assert.equal(refusals.length, 1);
				assert.equal(refusals[0]!.detail["reason"], `missing ${field}`);
			} finally {
				rmTemp(dir);
			}
		});
	}

	test("a complete call still records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rw-required-"));
		try {
			mkdirSync(join(dir, "brain"));
			const { call } = harness(dir);
			const text = await call(GOOD);
			assert.match(text, /^Recorded/, text);
			const files = written(dir);
			assert.equal(files.length, 1, files.join(","));
			assert.ok(!files[0]!.includes("undefined"));
		} finally {
			rmTemp(dir);
		}
	});
});
