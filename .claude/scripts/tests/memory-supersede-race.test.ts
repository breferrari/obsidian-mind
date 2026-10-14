/**
 * markSuperseded under real concurrency: several PROCESSES marking the same
 * memory at the same time, every title must land.
 *
 * This is the shape the deployment names — one server process per consuming
 * repo, all writing into one vault — and the shape the unguarded
 * read-modify-write lost 90 of 200 titles in (#328). A single-process test
 * cannot stand a writer in the gap between markSuperseded's read and its
 * rename, so the writers are child processes synchronised on a go file.
 *
 * Each writer retries (bounded) until its title is really on disk — the
 * contract the guarded rewrite offers: failures are reported, not lied about,
 * and a caller that retries does not lose titles. The assertion is the one
 * that matters: every minted title is present in the file at the end. Before
 * the guarded rewrite this failed in every round; the unit tests in
 * atomic-write.test.ts pin the mechanism (re-read before replace, replay on
 * fresh content, bounded attempts) deterministically.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rmTemp, waitFor } from "./_helpers.ts";

import { markSuperseded } from "../lib/memory-supersede.ts";

const PROCS = 4;
const FRESH_TITLES = 25; // must match _race-child.ts

describe("markSuperseded race", () => {
	test("concurrent writers all land their superseded_by title", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sup-race-"));
		try {
			const rel = "memories/2026/07/2026-07-26 old.md";
			const full = join(dir, rel);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(
				full,
				"---\ndate: 2026-07-26\nsource: mcp-capture\nscope: general\n---\n\n# old\n\nbody\n",
				"utf8",
			);
			const childPath = fileURLToPath(new URL("./_race-child.ts", import.meta.url));

			const goFile = join(dir, "go");
			const kids = Array.from({ length: PROCS }, (_, p) => {
				const doneFile = join(dir, `done-${p}.json`);
				const proc = spawn(
					process.execPath,
					["--experimental-strip-types", childPath, dir, rel, String(p), goFile, doneFile],
					{ stdio: ["ignore", "ignore", "pipe"] },
				);
				return { proc, doneFile };
			});

			// Only once every child is waiting on it: the start must be simultaneous.
			writeFileSync(goFile, "1");
			const exits = await Promise.all(
				kids.map((k) => new Promise<number>((res) => k.proc.on("exit", (c) => res(c ?? -1)))),
			);
			exits.forEach((code, i) => assert.equal(code, 0, `writer ${i} crashed`));

			await waitFor(() => kids.every((k) => existsSync(k.doneFile)));
			const silent = kids.filter((k) => !existsSync(k.doneFile));
			assert.deepEqual(
				silent.map((_, i) => i),
				[],
				"every writer must report back",
			);

			const reports = kids.map(
				(k) => JSON.parse(readFileSync(k.doneFile, "utf8")) as { landed: string[]; stuck: string[] },
			);
			const landed = reports.flatMap((r) => r.landed);
			assert.equal(landed.length, PROCS * FRESH_TITLES, "every minted title must land");
			const stuck = reports.flatMap((r) => r.stuck);
			assert.deepEqual(stuck, [], "no title may exhaust its retries");

			// Convergence: once the writers are done, any title a retrying caller
			// still finds missing lands on the next call. This is the guarantee the
			// guarded rewrite can make without a lock file — failures are reported,
			// retries succeed, nothing is silently gone — and it is the property the
			// deployment actually relies on.
			const allTitles: string[] = [];
			for (let p = 0; p < PROCS; p++)
				for (let n = 0; n < FRESH_TITLES; n++) allTitles.push(`Concurrent writer ${p}-${n}`);
			const listNow = () => readFileSync(full, "utf8").match(/superseded_by: \[(.*)\]/)?.[1] ?? "";
			for (const title of allTitles) {
				if (listNow().includes(JSON.stringify(title))) continue;
				const r = markSuperseded(dir, rel, title);
				assert.equal(r.ok, true, `repair of ${title} must succeed once writers are done`);
			}
			const missing = allTitles.filter((title) => !listNow().includes(JSON.stringify(title)));
			assert.deepEqual(missing, [], "after retries and repair, no title may be lost");
		} finally {
			rmTemp(dir);
		}
	});
});
