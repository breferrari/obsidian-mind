/**
 * Reading only the head of a file.
 *
 * This replaced `readFileSync(f, "utf8").slice(0, n)` on every hot path that
 * only wanted frontmatter, so the bar is EQUIVALENCE rather than merely
 * plausibility: every test that matters compares
 * against what the old expression returned for the same bytes. A prefix that is
 * subtly different would change which notes count as private, what descriptions
 * a listing carries, and which aliases resolve — all silently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHead } from "../lib/read-head.ts";

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "head-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** What the code this replaced would have returned. */
const oldWay = (path: string, chars: number): string => readFileSync(path, "utf8").slice(0, chars);

function put(dir: string, name: string, body: string): string {
	const full = join(dir, name);
	writeFileSync(full, body, "utf8");
	return full;
}

describe("reading a file head", () => {
	test("matches the whole-file read it replaced, across sizes", () => {
		withDir((dir) => {
			for (const [name, body] of [
				["tiny.md", "x"],
				["exact.md", "y".repeat(1200)],
				["long.md", "z".repeat(200_000)],
				["empty.md", ""],
			] as const) {
				const full = put(dir, name, body);
				assert.equal(readHead(full, 1200), oldWay(full, 1200), name);
			}
		});
	});

	test("a multibyte character spanning the read boundary is not corrupted", () => {
		// The buffer is sized in BYTES and the result sliced in CHARACTERS. A
		// character split by the end of the buffer decodes to U+FFFD, which must
		// always land beyond the slice — otherwise a CJK or emoji frontmatter value
		// comes back mangled, and only for files above a certain size.
		withDir((dir) => {
			for (const filler of ["日", "é", "🧠", "日本語テキスト"]) {
				const full = put(dir, "m.md", filler.repeat(5000));
				for (const n of [1, 7, 100, 799, 800, 1200]) {
					assert.equal(readHead(full, n), oldWay(full, n), `${filler} @ ${n}`);
					assert.ok(!String(readHead(full, n)).includes("�"), `${filler} @ ${n} must not corrupt`);
				}
			}
		});
	});

	test("frontmatter is intact even when the body is enormous", () => {
		withDir((dir) => {
			const full = put(dir, "big.md", `---\ndescription: "kept"\nprivate: true\n---\n\n${"x".repeat(500_000)}`);
			const head = readHead(full, 1200);
			assert.match(String(head), /description: "kept"/);
			assert.match(String(head), /private: true/);
		});
	});

	test("a file shorter than the request returns all of it", () => {
		withDir((dir) => {
			const full = put(dir, "s.md", "short");
			assert.equal(readHead(full, 1200), "short");
		});
	});

	test("unreadable inputs return null, so each caller keeps its own fallback", () => {
		withDir((dir) => {
			assert.equal(readHead(join(dir, "nope.md"), 100), null, "missing file");
			mkdirSync(join(dir, "adir"));
			assert.equal(readHead(join(dir, "adir"), 100), null, "a directory is not a file");
		});
	});

	test("a non-positive or nonsense length is an empty string, never a whole file", () => {
		withDir((dir) => {
			const full = put(dir, "x.md", "content");
			for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
				assert.equal(readHead(full, n), "", String(n));
			}
		});
	});
});
