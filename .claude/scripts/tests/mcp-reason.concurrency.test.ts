/**
 * Cross-process safety for the two files a `reason` call writes.
 *
 * Separate from the other reason tests for the reason `memory-write.concurrency`
 * is separate: the defects here CANNOT reproduce in-process. Node runs the
 * synchronous fs calls to completion, so a single-threaded test serialises them
 * and always passes — which is exactly how both of these survived a full
 * `/simplify` round.
 *
 * They became reachable when the spawn went async. While `runReasoning` used
 * `spawnSync` the whole event loop was held for the child's lifetime, so two
 * `reason` calls could never overlap and neither race existed. Making the server
 * responsive during a spawn — the right fix — opened both windows. The
 * deployment shape widens them further: one server process PER CONSUMING REPO,
 * all writing into one vault.
 *
 * 1. THE RECORD. Named from a millisecond-precision ISO stamp, which reads as
 *    collision-proof and is not. Under a plain write the loser silently
 *    overwrote the winner while both reported success — the same shape that made
 *    six processes produce four memories.
 *
 * 2. THE ISOLATED MCP CONFIG. A FIXED path rewritten on every call. A plain
 *    write truncates first, so a concurrent call can empty the file while
 *    another spawn's child is reading it — and what that child is reading is the
 *    recursion guard, the only thing stopping a spawn tree that multiplies at
 *    every level.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "mcp-reason.ts");
const LIB_URL = JSON.stringify(pathToFileURL(LIB).href);
const WRITERS = 8;

/** Run N scripts concurrently — all started before any is awaited. */
function runAll(script: string, argsFor: (i: number) => string[], n: number): Promise<string[]> {
	return Promise.all(
		Array.from(
			{ length: n },
			(_, i) =>
				new Promise<string>((res, rej) => {
					execFile(
						process.execPath,
						["--disable-warning=ExperimentalWarning", "--experimental-strip-types", script, ...argsFor(i)],
						{ encoding: "utf8" },
						(err, stdout, stderr) => (err ? rej(new Error(String(stderr || err.message))) : res(stdout.trim())),
					);
				}),
		),
	);
}

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "reason-conc-"));
	return fn(dir).finally(() =>
		// `maxRetries` is not optional on Windows here: these tests create and
		// rename hundreds of files across eight processes, and the directory stays
		// briefly busy after the last child exits — cleanup then throws ENOTEMPTY
		// and fails a test whose assertions already passed. Observed on this
		// suite; CI runs a Windows job, so without it the test is flaky there and
		// green everywhere else, which is the worst kind of red.
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
	);
}

// Every process writes a record stamped at the SAME instant, which is what two
// runs completing in the same millisecond produce.
const RECORD_WRITER = `
import { writeReasoningRecord } from ${LIB_URL};
const [vault, tag] = process.argv.slice(2);
const rel = writeReasoningRecord(vault, new Date("2026-07-27T10:00:00.123Z"), "question " + tag, {
  ok: true, answer: "ANSWER-" + tag, costUsd: 0.1, turns: 3,
  modelUsed: "m", terminal: "completed", wallMs: 1, error: null,
});
if (!rel) { console.error("no path returned"); process.exit(2); }
process.stdout.write(rel);
`;

// Half rewrite the config in a tight loop, half read it back and parse. A reader
// that ever sees a partial file fails loudly rather than silently.
const CONFIG_CHURN = `
import { readFileSync } from "node:fs";
import { writeIsolatedMcpConfig, writeIsolatedMcpConfigPath } from ${LIB_URL};
const [vault, role] = process.argv.slice(2);
const path = writeIsolatedMcpConfigPath(vault);
let torn = 0;
for (let i = 0; i < 400; i++) {
  if (role === "writer") {
    writeIsolatedMcpConfig(vault);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed.mcpServers !== "object") torn++;
    } catch {
      // ENOENT is fine only before the first write lands; an unparseable body
      // never is — that is the truncate window.
      torn++;
    }
  }
}
process.stdout.write(String(torn));
`;

describe("concurrent reason calls, from separate processes", () => {
	test("records stamped at the same instant all survive — none is clobbered", async () => {
		await withDir(async (dir) => {
			const script = join(dir, "record-writer.mjs");
			writeFileSync(script, RECORD_WRITER, "utf8");

			const paths = await runAll(script, (i) => [dir, `p${i}`], WRITERS);

			assert.equal(paths.length, WRITERS, "every writer must report a path");
			assert.equal(new Set(paths).size, WRITERS, `paths must be distinct, got ${new Set(paths).size}`);

			const onDisk = readdirSync(join(dir, ".claude", "om-reasoning")).filter((f) => f.endsWith(".md"));
			assert.equal(
				onDisk.length,
				WRITERS,
				`every reported record must exist — ${onDisk.length} files for ${WRITERS} successes means transcripts were lost`,
			);

			const leftovers = readdirSync(join(dir, ".claude", "om-reasoning")).filter((f) => f.endsWith(".tmp"));
			assert.deepEqual(leftovers, [], "no half-written record may be left behind");
		});
	});

	test("the recursion guard's config is never readable half-written", async () => {
		await withDir(async (dir) => {
			const script = join(dir, "config-churn.mjs");
			mkdirSync(join(dir, ".claude"), { recursive: true });
			writeFileSync(script, CONFIG_CHURN, "utf8");
			// Seed it so a reader starting first does not count a legitimate ENOENT.
			await runAll(script, () => [dir, "writer"], 1);

			const torn = await runAll(script, (i) => [dir, i % 2 === 0 ? "writer" : "reader"], WRITERS);
			const total = torn.reduce((a, s) => a + Number(s), 0);
			assert.equal(total, 0, `a spawn read a truncated or missing recursion guard ${total} time(s)`);

			const strays = readdirSync(join(dir, ".claude")).filter((f) => f.includes(".tmp"));
			assert.deepEqual(strays, [], "temp files must not accumulate beside the config");
		});
	});
});
