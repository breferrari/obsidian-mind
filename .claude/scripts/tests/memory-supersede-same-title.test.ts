/**
 * What `remember` may mark, compare and name, and for which caller: supersession
 * under a shared title (#364), and the near-duplicate check's reach (#375).
 *
 * A correction that keeps its title is the normal path, so a title can name
 * several memories. Resolving a `supersedes` claim to the first of them marked
 * whichever the listing put first: a third correction re-marked the memory
 * already retired and left the live wrong one live. Every memory the title
 * names is marked, and the reply names each file, so a title shared by
 * coincidence is visible to the caller rather than retired silently.
 *
 * Driven through the real `tools/call` dispatch, as mcp-refusal-audit does.
 * Calls pass `force: true` by default, so only the near-duplicate tests, which
 * pass `force: false`, meet that check.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandlers } from "../lib/mcp-server.ts";
import { recall } from "../lib/memory-recall.ts";

import { rmTemp } from "./_helpers.ts";

const TITLE = "tokens expire after one hour";
const BODY = "A body written for a session that will not have this context, long enough to clear the minimum.";

function harness(vaultRoot: string): { remember: (at: Date, args: Record<string, unknown>) => Promise<string> } {
	let clock = new Date(2026, 5, 1);
	const session = {
		roots: [{ uri: "file:///elsewhere/atlas", name: "atlas" }],
		identityReady: async () => {},
		ok: (_id: unknown, r: unknown) => r,
		error: (_id: unknown, e: unknown) => e,
	};
	const handlers = createHandlers({
		ctx: { vaultRoot, memoryRoot: "memories", qmdIndex: null },
		policy: { roots: ["brain"], never_expose: [] },
		session,
		qmd: () => ({}),
		audit: () => {},
		reindex: () => true,
		now: () => clock,
	} as never);
	const remember = async (at: Date, args: Record<string, unknown>): Promise<string> => {
		clock = at;
		const r = (await (handlers as never as Record<string, (id: number, p: unknown) => Promise<unknown>>)["tools/call"]!(1, {
			name: "remember",
			arguments: { title: TITLE, body: BODY, confidence: "verified", force: true, ...args },
		})) as { content: { text: string }[] };
		return r.content[0]!.text;
	};
	return { remember };
}

const recorded = (reply: string): string => /^Recorded: (.+)$/m.exec(reply)?.[1] ?? "";

/** Rescope a written memory to the harbor project, out of the atlas caller's reach. */
const scopeToHarbor = (file: string): void =>
	writeFileSync(file, readFileSync(file, "utf8").replace(/^scope: .*$/m, "scope: project").replace(/^projects: .*$/m, 'projects: ["harbor"]'));

describe("remember marks every memory a shared title names", () => {
	test("a third same-title correction retires the live wrong one, and the chain reaches only where its end does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-chain-"));
		try {
			const { remember } = harness(dir);
			await remember(new Date(2026, 5, 1), { scope: "general" });
			await remember(new Date(2026, 6, 1), { scope: "general", supersedes: [TITLE] });
			await remember(new Date(2026, 7, 1), { scope: "project", projects: ["atlas"], supersedes: [TITLE] });

			const live = (project: string) => recall(dir, { project, platforms: [] }).map((m) => m.facets.superseded_by.length);
			assert.deepEqual(live("beta"), [], "a caller outside the last correction's reach gets no part of the chain");
			assert.deepEqual(live("atlas"), [0, 1, 1], "the live correction first, both retired copies sunk");
		} finally {
			rmTemp(dir);
		}
	});

	test("two memories sharing a title by coincidence are both marked, and the reply names each file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-coincide-"));
		try {
			const { remember } = harness(dir);
			const first = recorded(await remember(new Date(2026, 5, 1), { scope: "general", body: `${BODY} About sessions.` }));
			const second = recorded(await remember(new Date(2026, 5, 2), { scope: "general", body: `${BODY} About API keys.` }));
			const reply = await remember(new Date(2026, 6, 1), { scope: "general", supersedes: [TITLE] });

			assert.ok(first && second && first !== second, "two distinct files were written");
			assert.ok(reply.includes(first), `the reply names ${first}`);
			assert.ok(reply.includes(second), `the reply names ${second}`);
			const marked = recall(dir, { project: "atlas", platforms: [] }).filter((m) => m.facets.superseded_by.length > 0);
			assert.deepEqual(marked.map((m) => m.rel).sort(), [first, second].sort());
		} finally {
			rmTemp(dir);
		}
	});

	test("a dry run names each file the claim would mark, before anything is marked", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-dry-"));
		try {
			const { remember } = harness(dir);
			const first = recorded(await remember(new Date(2026, 5, 1), { scope: "general", body: `${BODY} About sessions.` }));
			const second = recorded(await remember(new Date(2026, 5, 2), { scope: "general", body: `${BODY} About API keys.` }));
			const preview = await remember(new Date(2026, 6, 1), { scope: "general", supersedes: [TITLE], dry_run: true });

			assert.ok(preview.includes(first) && preview.includes(second), "the preview names both files");
			const marked = recall(dir, { project: "atlas", platforms: [] }).filter((m) => m.facets.superseded_by.length > 0);
			assert.deepEqual(marked, [], "a dry run marks nothing");
		} finally {
			rmTemp(dir);
		}
	});

	test("a match the server may not mark is named in the reply, not dropped", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-refused-"));
		try {
			const { remember } = harness(dir);
			const handFiled = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			const full = join(dir, handFiled);
			writeFileSync(full, readFileSync(full, "utf8").replace(/^source: .*$/m, "source: hand-filed"));
			const reply = await remember(new Date(2026, 6, 1), { scope: "general", supersedes: [TITLE] });

			assert.match(reply, /not marked/i);
			assert.ok(reply.includes(handFiled), `the reply names ${handFiled}`);
		} finally {
			rmTemp(dir);
		}
	});

	// A correction reaches only what its writer can see. Marking another
	// project's memory would withhold it from that project's own callers, whose
	// only replacement is out of their reach, and naming its file would show this
	// caller a memory recall never would.
	test("a match the caller cannot see is left alone, and its claim reads as not matched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-unseen-"));
		try {
			const { remember } = harness(dir);
			const theirs = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			const full = join(dir, theirs);
			scopeToHarbor(full);
			const reply = await remember(new Date(2026, 6, 1), { scope: "general", supersedes: [TITLE] });

			assert.ok(!reply.includes(theirs), "the reply does not name a memory outside the caller's reach");
			assert.match(reply, /Supersedes NOT matched: tokens expire after one hour/);
			assert.doesNotMatch(reply, /outside your reach/i, "nothing says another project holds the title");
			const harbor = recall(dir, { project: "harbor", platforms: [] });
			assert.deepEqual(harbor.find((m) => m.rel === theirs)?.facets.superseded_by, [], "harbor's memory is not marked");
		} finally {
			rmTemp(dir);
		}
	});

	test("a dry run keeps a match the server may not modify apart from what it would mark", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-dry-hand-"));
		try {
			const { remember } = harness(dir);
			const handFiled = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			const full = join(dir, handFiled);
			writeFileSync(full, readFileSync(full, "utf8").replace(/^source: .*$/m, "source: hand-filed"));
			const preview = await remember(new Date(2026, 6, 1), { scope: "general", supersedes: [TITLE], dry_run: true });

			assert.doesNotMatch(preview, /Would supersede/, "no mark is promised that the write would refuse");
			assert.match(preview, /would not be marked.*tokens expire after one hour/);
		} finally {
			rmTemp(dir);
		}
	});

	test("a memory recall already withholds from the caller is not named or marked either", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-withheld-"));
		try {
			const { remember } = harness(dir);
			// Withheld from atlas: its correction is scoped to harbor, out of atlas's reach.
			const withheld = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			const harborFix = recorded(await remember(new Date(2026, 5, 2), { scope: "general", title: "tokens expire after one hour (harbor)" }));
			const fixFull = join(dir, harborFix);
			scopeToHarbor(fixFull);
			const full = join(dir, withheld);
			writeFileSync(full, readFileSync(full, "utf8").replace(/^scope: general$/m, 'scope: general\nsuperseded_by: ["tokens expire after one hour (harbor)"]'));

			const reply = await remember(new Date(2026, 6, 1), { scope: "general", supersedes: [TITLE] });
			assert.ok(!reply.includes(withheld), "the reply does not name a memory recall withholds from the caller");
			assert.match(reply, /Supersedes NOT matched: tokens expire after one hour/);
		} finally {
			rmTemp(dir);
		}
	});
});

/**
 * The near-duplicate check judges a duplicate by where the NEW memory would be
 * read, in the caller's reach or not, and reach decides only what the refusal
 * names (#375). Comparing only against the caller's reach let a caller file a
 * second copy into a project it can't see, or restate a claim whose
 * correction it can't see and so undo that correction.
 */
describe("remember's near-duplicate check: compared where it would be read, named only in reach", () => {
	const RESTATED = `${BODY} Restated.`;

	test("a general write duplicating another project's memory is refused, without naming it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neardup-general-"));
		try {
			const { remember } = harness(dir);
			const theirs = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			scopeToHarbor(join(dir, theirs));

			const reply = await remember(new Date(2026, 6, 1), { scope: "general", force: false });
			assert.match(reply, /^Not recorded: a near-identical memory already exists where this one would be read/m);
			assert.ok(!reply.includes(theirs), "the reply does not name a memory outside the caller's reach");
			assert.ok(!reply.includes(TITLE), "nor its title");
		} finally {
			rmTemp(dir);
		}
	});

	test("a write scoped into another project is compared there, so it can't add a second copy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neardup-into-"));
		try {
			const { remember } = harness(dir);
			const theirs = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			scopeToHarbor(join(dir, theirs));

			const reply = await remember(new Date(2026, 6, 1), { scope: "project", projects: ["harbor"], force: false });
			assert.match(reply, /^Not recorded: a near-identical memory already exists where this one would be read/m);
			assert.ok(!reply.includes(theirs));
		} finally {
			rmTemp(dir);
		}
	});

	test("restating a claim whose correction is out of reach is refused, so the correction holds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neardup-retired-"));
		try {
			const { remember } = harness(dir);
			// A, general, corrected by a harbor-only memory: withheld from atlas.
			const retired = recorded(await remember(new Date(2026, 5, 1), { scope: "general", body: RESTATED }));
			const fix = recorded(
				await remember(new Date(2026, 5, 2), { scope: "general", title: "tokens expire after one hour (harbor)" }),
			);
			scopeToHarbor(join(dir, fix));
			const full = join(dir, retired);
			writeFileSync(
				full,
				readFileSync(full, "utf8").replace(/^scope: general$/m, 'scope: general\nsuperseded_by: ["tokens expire after one hour (harbor)"]'),
			);

			const reply = await remember(new Date(2026, 6, 1), { scope: "general", body: RESTATED, force: false });
			assert.match(reply, /^Not recorded: a near-identical memory already exists where this one would be read/m);
			assert.ok(!reply.includes(retired), "the withheld memory is not named either");
		} finally {
			rmTemp(dir);
		}
	});

	test("a write whose facets another project's copy doesn't share is recorded: two projects may each hold one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neardup-own-"));
		try {
			const { remember } = harness(dir);
			const theirs = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			scopeToHarbor(join(dir, theirs));

			const reply = await remember(new Date(2026, 6, 1), { scope: "project", projects: ["atlas"], force: false });
			assert.match(reply, /^Recorded: /m);
		} finally {
			rmTemp(dir);
		}
	});

	test("a near-identical memory the caller can see still refuses the write, and is named (the control)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neardup-control-"));
		try {
			const { remember } = harness(dir);
			const mine = recorded(await remember(new Date(2026, 5, 1), { scope: "general" }));
			const reply = await remember(new Date(2026, 6, 1), { scope: "general", force: false });
			assert.match(reply, /near-identical/);
			assert.ok(reply.includes(mine), "a memory in reach is named");
		} finally {
			rmTemp(dir);
		}
	});
});
