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
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { runScript as spawnHook } from "./_helpers.ts";

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

after(() => {
	// `maxRetries` + `retryDelay` is Node's documented Windows guard against
	// transient `EBUSY` / `EPERM` on rmdir when child processes or the OS
	// haven't fully released file handles yet. On Windows CI the test's tmp
	// dir occasionally lingers a few seconds after the detached qmd worker
	// finishes; retrying with linear backoff is the idiomatic fix.
	if (TMP_DIR) {
		rmSync(TMP_DIR, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 200,
		});
	}
});

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
