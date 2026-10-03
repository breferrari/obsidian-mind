/**
 * Subprocess integration test for the SessionStart hook.
 *
 * Spawns the hook exactly the way each agent's settings.json would:
 * `node --disable-warning=ExperimentalWarning --experimental-strip-types
 * session-start.ts` against a synthetic vault. Locks the contracts the
 * unit-level tests can't reach:
 *
 *  - Exit code 0 on a minimal vault (no manifest, no work/active/, no git).
 *  - stderr is silent — proves the warning-suppression flag is wired
 *    correctly on this hook, not just on qmd-refresh.
 *  - stdout contains every required section header, in order, so a
 *    regression that drops a section is caught.
 *  - openTasks emits "(no open tasks)" when work/active/ and the vault
 *    root are empty of user content — covers the post-#83 redesign at
 *    the orchestrator level (the pure-helper tests cover the algorithm).
 *  - openTasks emits a task with source attribution when work/active/
 *    contains one.
 *
 * Runs identically on Windows, macOS, and Linux. QMD's spawnSync inside
 * the hook is a graceful no-op when qmd isn't installed; when it is, the
 * incremental update against a tmp dir is fast and side-effect-free.
 */

import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { HOOK_OUTPUT_MAX_CHARS } from "../lib/hook-io.ts";
import { runScript as spawnHook, rmTemp } from "./_helpers.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(SCRIPT_DIR, "../session-start.ts");

let TMP_DIR = "";

before(() => {
	TMP_DIR = mkdtempSync(join(tmpdir(), "session-start-integration-"));
	mkdirSync(join(TMP_DIR, "brain"));
	mkdirSync(join(TMP_DIR, "work", "active"), { recursive: true });
	writeFileSync(
		join(TMP_DIR, "brain", "North Star.md"),
		"---\ndescription: test\n---\n\n# North Star\n\n- placeholder\n",
	);
	// Uppercase-extension fixture: locks the case-insensitive filter wiring
	// of `brainIndex()` (lists the topic without extension) and `listMd()`
	// (preserves the original `.MD` in the vault file listing). On
	// case-sensitive filesystems this is a distinct file; on Windows/macOS
	// case-insensitive filesystems it's the same dirent — either way the
	// listMd path must accept it and the brainIndex strip must drop the
	// extension regardless of case.
	writeFileSync(
		join(TMP_DIR, "brain", "Uppercase.MD"),
		"---\ndescription: locks case-insensitive .md detection\n---\n",
	);
});

// `rmTemp` retries — Node's documented Windows guard against transient
// `EBUSY` / `EPERM` on rmdir while a handle is still held — and then gives up
// quietly. The retries alone were not enough: #235 lost a green suite to an
// `EPERM` thrown out of this hook after the assertions had already passed.
after(() => rmTemp(TMP_DIR));

const runHook = () => spawnHook(SCRIPT, "", { CLAUDE_PROJECT_DIR: TMP_DIR });

const REQUIRED_SECTIONS = [
	"### Date",
	"### North Star (current goals)",
	"### Brain Topics (read on demand)",
	"### Recent Changes (last 48h)",
	"### Open Tasks",
	"### Active Work",
	"### Vault File Listing",
];

describe("session-start — silence contract and structure", () => {
	test("exits 0 with empty stderr on a minimal vault", () => {
		const { code, stderr } = runHook();
		assert.equal(code, 0);
		assert.equal(
			stderr,
			"",
			"hook must be silent on stderr — the --disable-warning=ExperimentalWarning flag in _helpers.ts is the regression guard for this contract",
		);
	});

	test("stdout contains every required section header in order", () => {
		const { stdout } = runHook();
		let cursor = 0;
		for (const header of REQUIRED_SECTIONS) {
			const idx = stdout.indexOf(header, cursor);
			assert.notEqual(
				idx,
				-1,
				`section "${header}" missing or out of order in hook output`,
			);
			cursor = idx + header.length;
		}
	});

	test("openTasks reports '(no open tasks)' for a vault with no user content", () => {
		// work/active/ is empty and vault root contains no non-infra .md files.
		const { stdout } = runHook();
		const open = stdout.split("### Open Tasks\n")[1]?.split("\n### ")[0];
		assert.ok(open !== undefined, "Open Tasks section should be present");
		assert.match(open ?? "", /\(no open tasks\)/);
	});

	test("`.MD` files (uppercase extension) appear in brain index and vault listing", () => {
		// Locks the case-insensitive wiring of `brainIndex()` and `listMd()`
		// at the hook level — the helper-level tests prove the predicate, this
		// proves the predicate is what each call site actually uses.
		const { stdout } = runHook();
		const brain =
			stdout.split("### Brain Topics (read on demand)\n")[1]?.split("\n### ")[0] ?? "";
		const listing =
			stdout.split("### Vault File Listing\n")[1] ?? "";
		// Brain index strips the extension (case-insensitive) — bare topic name.
		assert.match(
			brain,
			/Uppercase/,
			"brainIndex must list `.MD` topics with the extension stripped",
		);
		// Vault file listing preserves the original casing including extension.
		assert.match(
			listing,
			/Uppercase\.MD/,
			"listMd must include `.MD` files in the vault file listing",
		);
	});
});

describe("session-start — openTasks aggregation", () => {
	test("emits a task with source attribution when work/active/ has one", () => {
		const projectFile = join(TMP_DIR, "work", "active", "project-x.md");
		writeFileSync(
			projectFile,
			"---\ndescription: test project\n---\n\n## Tasks\n- [ ] do the thing\n- [x] already done\n",
		);
		try {
			const { stdout, stderr, code } = runHook();
			assert.equal(code, 0);
			assert.equal(stderr, "");
			const open = stdout.split("### Open Tasks\n")[1]?.split("\n### ")[0] ?? "";
			// Forward-slash source path (cross-platform display); only the
			// unchecked task surfaces; the checked one is filtered.
			assert.match(open, /work\/active\/project-x\.md/);
			assert.match(open, /- \[ \] do the thing/);
			assert.doesNotMatch(open, /already done/);
		} finally {
			rmSync(projectFile, { force: true });
		}
	});
});

/**
 * The eager layer must stay bounded as a vault grows. These run against a
 * SEPARATE oversized vault so the fixtures above stay minimal.
 */
describe("session-start — listing collapse and injection budget", () => {
	let BIG_DIR = "";

	before(() => {
		BIG_DIR = mkdtempSync(join(tmpdir(), "session-start-budget-"));
		mkdirSync(join(BIG_DIR, "brain"), { recursive: true });
		writeFileSync(
			join(BIG_DIR, "brain", "North Star.md"),
			"---\ndescription: test\n---\n\n# North Star\n\n- placeholder\n",
		);
		// 40 notes in one folder — well past the default threshold.
		mkdirSync(join(BIG_DIR, "people"), { recursive: true });
		for (let i = 0; i < 40; i++) {
			writeFileSync(
				join(BIG_DIR, "people", `Person ${String(i).padStart(2, "0")}.md`),
				"---\ndescription: x\n---\n\n# p\n",
			);
		}
		// 3 notes — comfortably under it.
		mkdirSync(join(BIG_DIR, "strategy"), { recursive: true });
		for (let i = 0; i < 3; i++) {
			writeFileSync(join(BIG_DIR, "strategy", `Doc ${i}.md`), "---\ndescription: x\n---\n");
		}
		// A TREE well past the threshold: 30 notes, but spread over subdirs.
		// It must stay expanded — folding it would hide the vault's shape.
		for (const p of ["alpha", "beta", "gamma"]) {
			mkdirSync(join(BIG_DIR, "projects", p), { recursive: true });
			for (let i = 0; i < 10; i++) {
				writeFileSync(
					join(BIG_DIR, "projects", p, `Note ${i}.md`),
					"---\ndescription: x\n---\n",
				);
			}
		}
	});

	after(() => rmTemp(BIG_DIR));

	const runBig = () => spawnHook(SCRIPT, "", { CLAUDE_PROJECT_DIR: BIG_DIR });
	const listingOf = (stdout: string) =>
		stdout.split("### Vault File Listing\n")[1]?.split("\n### ")[0] ?? "";

	test("a directory over the threshold collapses; one under it stays expanded", () => {
		const { stdout, code, stderr } = runBig();
		assert.equal(code, 0);
		assert.equal(stderr, "");
		const listing = listingOf(stdout);
		assert.match(
			listing,
			/\.\/people\/ — 40 notes \(listing collapsed/,
			"a 40-note folder must fold to one count line",
		);
		assert.doesNotMatch(listing, /Person 07/, "collapsed folders enumerate nothing");
		assert.match(listing, /strategy[\\/]Doc 1\.md/, "a 3-note folder stays expanded");
	});

	test("a 30-note TREE stays expanded — structure is navigation, not bulk", () => {
		const listing = listingOf(runBig().stdout);
		assert.doesNotMatch(
			listing,
			/\.\/projects\/ — \d+ notes/,
			"a directory with subdirectories must never collapse on size",
		);
		assert.match(listing, /projects[\\/]beta[\\/]Note 4\.md/);
		// Its flat leaves are still folded — 10 notes is under the default 12.
		assert.match(listing, /projects[\\/]alpha[\\/]Note 0\.md/);
	});

	test("no manifest budget → the hook output ceiling is the budget (#254)", () => {
		const { stdout } = runBig();
		const last = stdout.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
		assert.match(last, /^_context injected: \d+\.\dkB \/ 9\.1kB budget(?: — collapsed: [^_]+)?_$/);
	});

	test("a tight manifest budget degrades sections and NAMES them in the meter", () => {
		const manifest = join(BIG_DIR, "vault-manifest.json");
		writeFileSync(manifest, JSON.stringify({ eager_layer_budget_bytes: 400 }));
		try {
			const { stdout, code, stderr } = runBig();
			assert.equal(code, 0);
			assert.equal(stderr, "", "the budget must never break the silence contract");

			const last = stdout.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
			assert.match(
				last,
				/^_context injected: \d+\.\dkB \/ 0\.4kB budget — collapsed: .+_$/,
				`meter must report the ceiling and name what it dropped, got: ${last}`,
			);
			// The listing is the first thing surrendered.
			assert.match(last, /collapsed: Vault File Listing/);
			assert.match(listingOf(stdout), /Over budget/, "dropped body is a pointer, not silence");
			// Degrading is never truncation: the header survives so the session
			// knows the section exists and can go get it.
			assert.ok(stdout.includes("### Vault File Listing"));
			assert.ok(stdout.includes("### Date"), "load-bearing sections are untouched");
		} finally {
			rmSync(manifest, { force: true });
		}
	});

	test("a budget under the ceiling collapses nothing it does not need to and reports itself", () => {
		const manifest = join(BIG_DIR, "vault-manifest.json");
		writeFileSync(manifest, JSON.stringify({ eager_layer_budget_bytes: 9_000 }));
		try {
			const last =
				runBig().stdout.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
			assert.match(last, /^_context injected: \d+\.\dkB \/ 9\.0kB budget_$/);
		} finally {
			rmSync(manifest, { force: true });
		}
	});

	test("a budget above the hook output cap is clamped, and the meter says so (#254)", () => {
		const manifest = join(BIG_DIR, "vault-manifest.json");
		writeFileSync(manifest, JSON.stringify({ eager_layer_budget_bytes: 80_000 }));
		try {
			const last =
				runBig().stdout.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
			assert.match(
				last,
				/^_context injected: \d+\.\dkB \/ 9\.1kB budget \(80\.0kB configured, held under the hook output cap\)(?: — collapsed: [^_]+)?_$/,
			);
		} finally {
			rmSync(manifest, { force: true });
		}
	});

	test("manifest threshold overrides the default", () => {
		const manifest = join(BIG_DIR, "vault-manifest.json");
		writeFileSync(manifest, JSON.stringify({ listing_collapse_threshold: 2 }));
		try {
			const listing = listingOf(runBig().stdout);
			assert.match(
				listing,
				/\.\/strategy\/ — 3 notes \(listing collapsed/,
				"a threshold of 2 must fold the 3-note folder that the default kept",
			);
		} finally {
			rmSync(manifest, { force: true });
		}
	});
});

/**
 * Claude Code caps a hook's plain stdout at 10,000 characters; past it, the
 * session gets a file path and the first 2,000 characters (#254). The output
 * must fit whole, with the meter as its last line, whatever the vault holds.
 */
const lastLine = (stdout: string) => stdout.split("\n").filter((l) => l.trim() !== "").pop() ?? "";

/**
 * ~250 nested notes: the shape that reproduced #254. Nested project folders,
 * each under the listing-collapse threshold, so nothing folds by count and
 * the listing alone passes the hook cap.
 */
function nestedVault(manifest: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "session-start-nested-"));
	mkdirSync(join(dir, "brain"), { recursive: true });
	writeFileSync(join(dir, "brain", "North Star.md"), "---\ndescription: test\n---\n\n# North Star\n\n- placeholder\n");
	for (let p = 0; p < 12; p++) {
		for (const sub of ["notes", "decisions"]) {
			mkdirSync(join(dir, "projects", `project-${p}`, sub), { recursive: true });
			for (let i = 0; i < 10; i++) {
				writeFileSync(join(dir, "projects", `project-${p}`, sub, `Example project-${p} ${sub} note ${i}.md`), "---\ndescription: x\n---\n");
			}
		}
	}
	writeFileSync(join(dir, "vault-manifest.json"), JSON.stringify(manifest));
	return dir;
}

describe("session-start — the hook output cap", () => {
	const CAP = HOOK_OUTPUT_MAX_CHARS;

	test("an ordinary vault of ~250 nested notes fits, the listing degrading first", () => {
		const dir = nestedVault({ eager_layer_budget_bytes: 80_000 });
		try {
			const { stdout, code, stderr } = spawnHook(SCRIPT, "", { CLAUDE_PROJECT_DIR: dir });
			assert.equal(code, 0);
			assert.equal(stderr, "");
			assert.ok(stdout.length <= CAP, `stdout is ${stdout.length} characters`);
			assert.match(lastLine(stdout), /^_context injected: .* — collapsed: Vault File Listing_$/);
		} finally {
			rmTemp(dir);
		}
	});

	test("sections that never degrade cannot carry the output past the cap: it is cut, and the meter says so", () => {
		// Open tasks never degrade. Ten long ones are over the cap on their own,
		// with every degradable section already a pointer.
		const dir = mkdtempSync(join(tmpdir(), "session-start-cut-"));
		try {
			const tasks = Array.from({ length: 10 }, (_, i) => `- [ ] task ${i} ${"x".repeat(1_500)}`).join("\n");
			writeFileSync(join(dir, "Tasks.md"), `# Tasks\n\n${tasks}\n`);
			const { stdout, code, stderr } = spawnHook(SCRIPT, "", { CLAUDE_PROJECT_DIR: dir });
			assert.equal(code, 0);
			assert.equal(stderr, "");
			assert.ok(stdout.includes("task 0 "), "the fixture's tasks reached the output");
			assert.ok(stdout.length <= CAP, `stdout is ${stdout.length} characters`);
			assert.ok(stdout.includes("… (truncated to fit the hook output cap)"), "the cut is marked where it happened");
			assert.match(lastLine(stdout), /^_context injected: .* — truncated to fit the hook output cap_$/);
		} finally {
			rmTemp(dir);
		}
	});
});

/**
 * A Claude Code mod that delivers the eager layer itself passes `om_mod` on
 * the event (#264, lib/om-mod.ts). `standdown` must leave no trace at all;
 * `deliver` is the mod's own run, whose output becomes an instruction file:
 * always the full layer, held to its own budget, never cut to the hook cap.
 */
describe("session-start — om_mod (a Claude Code mod)", () => {
	test("standdown prints nothing and runs no side effect", () => {
		const envFile = join(TMP_DIR, "env-standdown.sh");
		writeFileSync(envFile, "");
		const { stdout, stderr, code } = spawnHook(SCRIPT, { source: "startup", om_mod: "standdown" }, { CLAUDE_PROJECT_DIR: TMP_DIR, CLAUDE_ENV_FILE: envFile });
		assert.equal(code, 0);
		assert.equal(stderr, "");
		assert.equal(stdout, "", "the mod delivers this event; the hook must add nothing");
		assert.equal(readFileSync(envFile, "utf-8"), "", "no VAULT_PATH export: side effects belong to the mod's own run");
	});

	test("without the flag the same run does write VAULT_PATH (the standdown check above can fail)", () => {
		const envFile = join(TMP_DIR, "env-plain.sh");
		writeFileSync(envFile, "");
		const { stdout } = spawnHook(SCRIPT, { source: "startup" }, { CLAUDE_PROJECT_DIR: TMP_DIR, CLAUDE_ENV_FILE: envFile });
		assert.ok(stdout.includes("### Date"));
		assert.match(readFileSync(envFile, "utf-8"), /VAULT_PATH/);
	});

	test("deliver is not cut to the hook-output cap: the layer arrives whole, against its own budget", () => {
		// Different values, so reading the wrong field cannot pass.
		const dir = nestedVault({ eager_layer_budget_bytes: 9_000, eager_layer_instruction_budget_bytes: 80_000 });
		try {
			const delivered = spawnHook(SCRIPT, { source: "startup", om_mod: "deliver" }, { CLAUDE_PROJECT_DIR: dir });
			assert.equal(delivered.code, 0);
			assert.equal(delivered.stderr, "");
			assert.ok(delivered.stdout.length > HOOK_OUTPUT_MAX_CHARS, `delivered ${delivered.stdout.length} characters`);
			assert.match(lastLine(delivered.stdout), /^_context injected: \d+\.\dkB \/ 80\.0kB budget_$/, "nothing collapsed, nothing clamped, meter last");
			assert.ok(delivered.stdout.includes("Example project-11 decisions note 9.md"), "the deepest listing entry is there");

			// The same vault as hook output stays under the cap (#254), listing degraded.
			const hooked = spawnHook(SCRIPT, { source: "startup" }, { CLAUDE_PROJECT_DIR: dir });
			assert.ok(hooked.stdout.length <= HOOK_OUTPUT_MAX_CHARS);
			assert.match(lastLine(hooked.stdout), /collapsed: Vault File Listing/);
		} finally {
			rmTemp(dir);
		}
	});

	test("deliver without a configured instruction budget uses the default", () => {
		const dir = nestedVault();
		try {
			const { stdout } = spawnHook(SCRIPT, { source: "startup", om_mod: "deliver" }, { CLAUDE_PROJECT_DIR: dir });
			assert.match(lastLine(stdout), /\/ 20\.0kB budget/);
		} finally {
			rmTemp(dir);
		}
	});

	test("deliver is the full layer even on compact: an instruction file has no pointer mode", () => {
		const delivered = spawnHook(SCRIPT, { source: "compact", om_mod: "deliver" }, { CLAUDE_PROJECT_DIR: TMP_DIR }).stdout;
		assert.ok(delivered.includes("### Vault File Listing"));
		assert.ok(!delivered.includes("### Context Pointer"));
		const hooked = spawnHook(SCRIPT, { source: "compact" }, { CLAUDE_PROJECT_DIR: TMP_DIR }).stdout;
		assert.ok(hooked.includes("### Context Pointer"), "without the flag compact stays pointer mode");
	});

	test("an unknown om_mod value changes nothing: output identical to a run with no flag", () => {
		const plain = spawnHook(SCRIPT, { source: "startup" }, { CLAUDE_PROJECT_DIR: TMP_DIR });
		const unknown = spawnHook(SCRIPT, { source: "startup", om_mod: "silence" }, { CLAUDE_PROJECT_DIR: TMP_DIR });
		assert.equal(unknown.code, 0);
		assert.equal(unknown.stdout, plain.stdout);
		assert.ok(plain.stdout.includes("### Date"));
	});

	test("standdown exits before every side effect: it never reaches the project directory", () => {
		// Every side effect (VAULT_PATH, the QMD preflight and spawn, the scans)
		// comes after the chdir into the project directory. A missing directory
		// makes that chdir throw, so only a run that left before it exits clean.
		const missing = join(TMP_DIR, "no-such-vault");
		const plain = spawnHook(SCRIPT, { source: "startup" }, { CLAUDE_PROJECT_DIR: missing });
		assert.notEqual(plain.code, 0, "without the flag the run reaches the chdir and fails");
		const stood = spawnHook(SCRIPT, { source: "startup", om_mod: "standdown" }, { CLAUDE_PROJECT_DIR: missing });
		assert.equal(stood.code, 0);
		assert.equal(stood.stdout, "");
		assert.equal(stood.stderr, "");
	});
});
