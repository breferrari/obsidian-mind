/**
 * Cross-process write safety.
 *
 * Separate from the other write tests because the defect it guards CANNOT
 * reproduce in-process: Node runs the synchronous fs calls to completion, so a
 * single-threaded test always serialises them and always passes.
 *
 * It matters because the deployment shape is one server process PER CONSUMING
 * REPO, all writing into one vault. An adversarial run with six processes
 * recording the same lesson title produced FOUR files and SIX success messages
 * — two memories lost silently, which is the worst outcome available to a layer
 * whose whole job is not losing them.
 *
 * The cause was `while (existsSync(x)) bump(x); writeFileSync(x)`: both
 * processes see the name free, both write, one clobbers the other. The fix is
 * an atomic exclusive create, which fails instead of overwriting so the loser
 * takes the next suffix.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "memory-write.ts");
const WRITERS = 8;

/**
 * A tiny script that performs one write and prints the path it claimed.
 *
 * The import must be a `file://` URL: on Windows an absolute path starting with
 * a drive letter is read by the ESM loader as an unsupported URL scheme.
 */
const WRITER_SRC = `
import { validateMemory, writeMemory } from ${JSON.stringify(pathToFileURL(LIB).href)};
const [vault, origin] = process.argv.slice(2);
const v = validateMemory(
  {
    title: "the same lesson title from every process",
    body: "Identical body from every writer, chosen so the filename collides and the atomic claim is the only thing separating them.",
    confidence: "inferred",
    scope: "project",
    projects: [origin],
  },
  { now: new Date("2026-07-26"), origin },
);
if (!v.ok) { console.error("INVALID: " + v.errors.join("; ")); process.exit(2); }
process.stdout.write(writeMemory(vault, v.value, [], { root: "memories" }).rel);
`;

describe("concurrent writes from separate processes", () => {
	test("every process gets its own file — none is silently clobbered", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conc-"));
		try {
			const script = join(dir, "writer.mjs");
			mkdirSync(join(dir, "memories", "2026", "07"), { recursive: true });
			writeFileSync(script, WRITER_SRC, "utf8");

			// All started BEFORE any is awaited. A synchronous exec would serialise
			// them and the race — which is the entire point — would never occur.
			const procs = await Promise.all(
				Array.from(
					{ length: WRITERS },
					(_, i) =>
						new Promise<string>((res, rej) => {
							execFile(
								process.execPath,
								["--disable-warning=ExperimentalWarning", "--experimental-strip-types", script, dir, `repo-${i}`],
								{ encoding: "utf8" },
								(err, stdout, stderr) => (err ? rej(new Error(String(stderr || err.message))) : res(stdout.trim())),
							);
						}),
				),
			);

			assert.equal(procs.length, WRITERS, "every writer must report a path");
			assert.equal(new Set(procs).size, WRITERS, `paths must be distinct, got ${new Set(procs).size}`);

			const onDisk = readdirSync(join(dir, "memories", "2026", "07")).filter((f) => f.endsWith(".md"));
			assert.equal(
				onDisk.length,
				WRITERS,
				`every reported write must exist on disk — ${onDisk.length} files for ${WRITERS} successes means memories were lost`,
			);

			const leftovers = readdirSync(join(dir, "memories", "2026", "07")).filter((f) => f.endsWith(".tmp"));
			assert.deepEqual(leftovers, [], "no half-written note may be left for the indexer");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
