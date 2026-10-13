/**
 * One concurrent writer for memory-supersede-race.test.ts.
 *
 * Waits for `goFile`, then marks the memory with `FRESH_TITLES` distinct
 * titles. After each call it re-reads the file and confirms the title is
 * really there; a refusal or a vanished title goes back on the queue, and a
 * per-title attempt bound keeps a pathological run finite.
 *
 * That verify-and-retry loop is the contract the guarded rewrite offers: the
 * caller is told when a write did not land (`ok: false`) instead of being
 * lied to, and a caller that retries does not lose titles. Run as a PROCESS,
 * not a worker thread: the bug under test lives in the gap between one
 * process's read and its rename, and only a separate process can stand in
 * another's gap.
 */

import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { markSuperseded } from "../lib/memory-supersede.ts";

const [vaultRaw, rel, procId, goFile, doneFile] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
	string,
];
const vault = realpathSync(vaultRaw);
const full = join(vault, rel);

// A finite workload: once no child is minting fresh titles, contention decays
// and the drain succeeds. An unbounded writer keeps the vault churning while
// it repairs, and can starve its own retries.
const FRESH_TITLES = 25;
const MAX_ATTEMPTS_PER_TITLE = 40;

while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 2));

const landed: string[] = [];
const queue: { title: string; tries: number }[] = [];
for (let n = 0; n < FRESH_TITLES; n++) queue.push({ title: `Concurrent writer ${procId}-${n}`, tries: 0 });

while (queue.length > 0) {
	const job = queue.shift()!;
	const r = markSuperseded(vault, rel, job.title);
	let done = false;
	if (r.ok && r.changed) {
		// The write reported success: confirm it is still on disk before counting it.
		if (readFileSync(full, "utf8").includes(JSON.stringify(job.title))) {
			landed.push(job.title);
			done = true;
		}
	}
	if (!done) {
		if (++job.tries < MAX_ATTEMPTS_PER_TITLE) {
			queue.push(job);
			// Back off: re-firing into the same instant re-collides, and a
			// writer that hammers keeps the vault churning for everyone.
			await new Promise((r2) => setTimeout(r2, 1 + Math.random() * 3));
		}
	}
}

writeFileSync(doneFile, JSON.stringify({ landed, stuck: queue.map((j) => j.title) }));
