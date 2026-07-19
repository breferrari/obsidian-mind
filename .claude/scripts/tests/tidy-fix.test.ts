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
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../tidy-fix.ts",
);

let ROOT = "";
let MEMDIR = "";

function run(args: string[]): { stdout: string; code: number } {
	const r = spawnSync(
		process.execPath,
		["--disable-warning=ExperimentalWarning", "--experimental-strip-types", SCRIPT, ...args],
		{
			encoding: "utf-8",
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: ROOT,
				TIDY_FIX_MEMORY_DIR: MEMDIR,
			},
		},
	);
	return { stdout: r.stdout ?? "", code: r.status ?? -1 };
}

function note(rel: string, status: string, date: string): void {
	const full = join(ROOT, rel);
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
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(MEMDIR, { recursive: true, force: true });
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
