/**
 * Drift guard: the record-directory list has THREE statements of one rule.
 *
 * `lib/correction-sweep.ts` holds the predicate. `.claude/commands/om-correct.md`
 * and `.claude/agents/correction-sweep.md` restate it in prose, and prose is
 * what the agent actually reads and acts on — nothing in the runtime imports
 * the predicate, because the sweep is executed by an agent following the
 * command, not by TypeScript calling a function.
 *
 * That is the same shape as the `promoted:` marker, which had three parsers
 * until one was made authoritative (#183). Here the cheaper fix applies: keep
 * the prose, since the agent needs it inline, and FAIL when it stops matching
 * the predicate so the two cannot drift silently.
 *
 * The failure this prevents is not cosmetic. The directory list IS the safety
 * property — it decides which notes may never be edited — so a doc listing one
 * fewer directory than the predicate is an agent that will happily rewrite a
 * record the tests believe is protected.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The directory names the predicate treats as record-keeping. */
function predicateDirs(): string[] {
	const src = readFileSync(join(root, ".claude/scripts/lib/correction-sweep.ts"), "utf-8");
	const block = src.match(/const HISTORICAL_DIRS = new Set\(\[([\s\S]*?)\]\)/);
	assert.ok(block, "HISTORICAL_DIRS literal not found — this guard needs updating");
	return [...(block[1] ?? "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!).sort();
}

/** The directory names a doc tells the agent to treat as record-keeping. */
function docDirs(relPath: string): string[] {
	const src = readFileSync(join(root, relPath), "utf-8");
	// Both docs write them as inline code with a trailing slash: `journal/`.
	return [...new Set([...src.matchAll(/`([a-z0-9-]+)\/`/g)].map((m) => m[1]!))].sort();
}

describe("correction-sweep: predicate and prose state one rule", () => {
	test("the predicate lists a non-trivial set", () => {
		// Guards the guard: a regex that silently matched nothing would make
		// every comparison below pass by being empty on both sides.
		const dirs = predicateDirs();
		assert.ok(dirs.length >= 5, `expected the real set, parsed ${JSON.stringify(dirs)}`);
		assert.ok(dirs.includes("archive"), "archive is the one that must never be missing");
	});

	test("the command doc matches the predicate exactly", () => {
		assert.deepEqual(
			docDirs(".claude/commands/om-correct.md"),
			predicateDirs(),
			"/om-correct's record-directory list drifted from lib/correction-sweep.ts",
		);
	});

	test("the agent doc matches the predicate exactly", () => {
		assert.deepEqual(
			docDirs(".claude/agents/correction-sweep.md"),
			predicateDirs(),
			"the correction-sweep agent's record-directory list drifted from the predicate",
		);
	});
});
