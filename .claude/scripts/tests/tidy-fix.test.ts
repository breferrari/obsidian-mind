/**
 * Subprocess tests for tidy-fix.ts (#139) — the deterministic --fix
 * consumer. Fixture vault in a tmpdir (non-git, so the plain-rename
 * fallback path is exercised); memory dir routed via TIDY_FIX_MEMORY_DIR.
 * Asserts both tiers: acts on the deterministic classes, refuses the
 * judgment classes, dry-run touches nothing, second run fixes nothing.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { rmTemp } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../tidy-fix.ts",
);

let ROOT = "";
let MEMDIR = "";

function run(
	args: string[],
	root = ROOT,
	memDir = MEMDIR,
): { stdout: string; code: number } {
	const r = spawnSync(
		process.execPath,
		["--disable-warning=ExperimentalWarning", "--experimental-strip-types", SCRIPT, ...args],
		{
			encoding: "utf-8",
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: root,
				TIDY_FIX_MEMORY_DIR: memDir,
			},
		},
	);
	return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

/** The lines under one report heading, up to the next blank line. */
function section(stdout: string, heading: RegExp): string[] {
	const lines = stdout.split(/\r?\n/);
	const at = lines.findIndex((l) => heading.test(l));
	if (at === -1) return [];
	const out: string[] = [];
	for (const l of lines.slice(at + 1)) {
		if (l.trim() === "") break;
		out.push(l.trim());
	}
	return out;
}

function note(rel: string, status: string, date: string, root = ROOT): void {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(
		full,
		`---\nstatus: ${status}\ndate: ${date}\ndescription: "d"\ntags: [x]\n---\n[[Link]]\n`,
	);
}

before(() => {
	ROOT = mkdtempSync(join(tmpdir(), "tidy-fix-test-"));
	MEMDIR = mkdtempSync(join(tmpdir(), "tidy-fix-mem-"));
	note("work/active/Done Solo.md", "completed", "2025-06-01");
	note("work/active/Live One.md", "active", "2026-07-01");
	note("work/active/Mixed Topic/Done.md", "completed", "2026-01-01");
	note("work/active/Mixed Topic/Live.md", "active", "2026-01-01");
	note("work/active/Full Topic/A.md", "completed", "2024-03-01");
	note("work/active/Full Topic/B.md", "completed", "2024-04-01");
	note("work/active/Split Years/A.md", "completed", "2023-11-01");
	note("work/active/Split Years/B.md", "completed", "2024-02-01");
	mkdirSync(join(ROOT, "brain"), { recursive: true });
	writeFileSync(
		join(ROOT, "brain/Patterns.md"),
		'---\ndescription: "patterns"\n---\n# P\n',
	);
	writeFileSync(join(ROOT, "brain/Collide.md"), "# existing brain note\n");
	writeFileSync(join(MEMDIR, "MEMORY.md"), "old index\n");
	writeFileSync(join(MEMDIR, "stray-note.md"), "# stray durable knowledge\n");
	writeFileSync(join(MEMDIR, "Collide.md"), "# different content\n");
});

after(() => {
	rmTemp(ROOT);
	rmTemp(MEMDIR);
});

describe("tidy-fix", () => {
	test("dry-run lists both tiers and touches nothing", () => {
		const { stdout, code } = run([]);
		assert.equal(code, 0);
		assert.match(stdout, /DRY-RUN/);
		assert.match(stdout, /Would fix:/);
		assert.match(stdout, /Done Solo\.md → work\/archive\/2025\/Done Solo\.md/);
		assert.match(stdout, /Full Topic\/ → work\/archive\/2024\/Full Topic\/ \(whole cluster\)/);
		assert.match(stdout, /Mixed Topic\/ — mixed cluster/);
		assert.match(stdout, /Split Years\/ — completed notes span years \(2023, 2024\)/);
		assert.match(stdout, /stray-note\.md → brain\/stray-note\.md/);
		assert.match(stdout, /memory\/Collide\.md — brain\/Collide\.md already exists/);
		// Nothing moved.
		assert.ok(existsSync(join(ROOT, "work/active/Done Solo.md")));
		assert.ok(existsSync(join(MEMDIR, "stray-note.md")));
		assert.ok(!existsSync(join(ROOT, "brain/stray-note.md")));
	});

	test("apply acts on the deterministic tier only", () => {
		const { stdout, code } = run(["--apply"]);
		assert.equal(code, 0);
		assert.match(stdout, /APPLIED/);
		// Solo completed → year from frontmatter.
		assert.ok(existsSync(join(ROOT, "work/archive/2025/Done Solo.md")));
		assert.ok(!existsSync(join(ROOT, "work/active/Done Solo.md")));
		// Fully-completed cluster moves whole.
		assert.ok(existsSync(join(ROOT, "work/archive/2024/Full Topic/A.md")));
		assert.ok(!existsSync(join(ROOT, "work/active/Full Topic")));
		// Multi-year cluster refused — untouched.
		assert.ok(existsSync(join(ROOT, "work/active/Split Years/A.md")));
		// Mixed cluster refused — untouched.
		assert.ok(existsSync(join(ROOT, "work/active/Mixed Topic/Done.md")));
		assert.ok(existsSync(join(ROOT, "work/active/Mixed Topic/Live.md")));
		// Active note untouched.
		assert.ok(existsSync(join(ROOT, "work/active/Live One.md")));
		// Memory stray: copied, verified, removed; index regenerated.
		assert.equal(
			readFileSync(join(ROOT, "brain/stray-note.md"), "utf-8"),
			"# stray durable knowledge\n",
		);
		assert.ok(!existsSync(join(MEMDIR, "stray-note.md")));
		const index = readFileSync(join(MEMDIR, "MEMORY.md"), "utf-8");
		assert.match(index, /\[\[brain\/stray-note\]\]/);
		assert.match(index, /\[\[brain\/Patterns\]\] — patterns/);
		// Collision refused: stray stays, brain note unchanged.
		assert.ok(existsSync(join(MEMDIR, "Collide.md")));
		assert.equal(
			readFileSync(join(ROOT, "brain/Collide.md"), "utf-8"),
			"# existing brain note\n",
		);
	});

	test("second apply run fixes nothing (idempotent); refusals persist", () => {
		const { stdout, code } = run(["--apply"]);
		assert.equal(code, 0);
		assert.doesNotMatch(stdout, /^Fixed:$/m);
		assert.doesNotMatch(stdout, /Done Solo/);
		assert.doesNotMatch(stdout, /stray-note/);
		// The judgment findings are still surfaced.
		assert.match(stdout, /Mixed Topic\/ — mixed cluster/);
		assert.match(stdout, /Refused \(judgment — run \/om-tidy\)/);
	});
});

/**
 * "Fixed:" under --apply used to be written before the action ran and never
 * corrected, so a move that failed — or a stray that could not be read —
 * still printed as fixed, and an unreadable stray threw and ended the run.
 */
describe("tidy-fix — failures are reported as failed, never fixed", () => {
	let root = "";
	let mem = "";

	before(() => {
		root = mkdtempSync(join(tmpdir(), "tidy-fix-fail-"));
		mem = mkdtempSync(join(tmpdir(), "tidy-fix-fail-mem-"));
		note("work/active/Blocked.md", "completed", "2025-06-01", root);
		note("work/active/Movable.md", "completed", "2025-06-01", root);
		// The destination is a non-empty directory: neither git mv (no repo
		// here) nor a plain rename can put the note there.
		mkdirSync(join(root, "work/archive/2025/Blocked.md"), { recursive: true });
		writeFileSync(join(root, "work/archive/2025/Blocked.md/keep.txt"), "x");
		mkdirSync(join(root, "brain"), { recursive: true });
		writeFileSync(join(mem, "MEMORY.md"), "old index\n");
		// A directory with a markdown name: listed as a stray, unreadable.
		mkdirSync(join(mem, "unreadable.md"));
		writeFileSync(join(mem, "good.md"), "# good\n");
	});

	after(() => {
		rmTemp(root);
		rmTemp(mem);
	});

	test("a failed move and an unreadable stray land under Failed, the rest still go", () => {
		const { stdout, code } = run(["--apply"], root, mem);
		const fixed = section(stdout, /^Fixed:$/);
		const failed = section(stdout, /^Failed/);

		assert.ok(failed.some((l) => l.startsWith("work/active/Blocked.md →")), stdout);
		assert.ok(!fixed.some((l) => l.includes("Blocked.md")), stdout);
		assert.ok(existsSync(join(root, "work/active/Blocked.md")));

		assert.ok(failed.some((l) => l.startsWith("memory/unreadable.md →")), stdout);
		assert.ok(!fixed.some((l) => l.includes("unreadable.md")), stdout);

		// The run did not stop at the first failure.
		assert.ok(fixed.some((l) => l.startsWith("work/active/Movable.md →")), stdout);
		assert.ok(existsSync(join(root, "work/archive/2025/Movable.md")));
		assert.ok(fixed.some((l) => l.startsWith("memory/good.md →")), stdout);
		assert.equal(readFileSync(join(root, "brain/good.md"), "utf-8"), "# good\n");

		assert.equal(code, 1, "a failed fix must not exit clean");
	});

	test("dry-run still lists every planned fix and exits 0", () => {
		const r = mkdtempSync(join(tmpdir(), "tidy-fix-dry-"));
		try {
			note("work/active/Blocked.md", "completed", "2025-06-01", r);
			mkdirSync(join(r, "work/archive/2025/Blocked.md"), { recursive: true });
			const { stdout, code } = run([], r, mem);
			assert.equal(code, 0);
			assert.ok(section(stdout, /^Would fix:$/).some((l) => l.startsWith("work/active/Blocked.md →")));
			assert.deepEqual(section(stdout, /^Failed/), []);
		} finally {
			rmTemp(r);
		}
	});
});
