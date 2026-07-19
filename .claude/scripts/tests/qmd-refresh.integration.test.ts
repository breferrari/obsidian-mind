/**
 * Subprocess integration tests for the QMD-refresh trigger inside the
 * validate-write.ts PostToolUse hook (which absorbed the retired
 * standalone qmd-refresh.ts entry on 2026-07-14 — one spawn per write).
 *
 * Exercises the real stdin → decision → sentinel pipeline by spawning
 * the hook entry script exactly the way each agent's settings.json
 * would: `node --disable-warning=ExperimentalWarning --experimental-strip-types
 * validate-write.ts` with a JSON payload on stdin. The sentinel file is
 * the refresh trigger's only observable (the fixtures below all resolve
 * to nonexistent or out-of-root files, so validation itself stays
 * silent), so each test asserts on sentinel presence / mtime + exit code.
 *
 * Deliberately does NOT depend on qmd being installed. The trigger's
 * short-circuit when `resolveQmdEntry()` returns null means the
 * "sentinel NOT touched" path still runs cleanly on a minimal CI image
 * without polluting anyone's QMD cache. The qmd-installed path is
 * handled by guarded tests that check `resolveQmdEntry()` directly
 * and assert the alternate branch when qmd isn't available.
 *
 * Runs identically on Windows, macOS, and Linux — the hook's
 * cross-platform shape is asserted through the same spawn mechanism
 * that powers validate-write.test.ts and stop-checklist.test.ts.
 */

import { test, describe, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { runScript as spawnHook } from "./_helpers.ts";
import { resolveQmdEntry } from "../lib/qmd.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(SCRIPT_DIR, "../validate-write.ts");

// Route the hook's debounce sentinel through a per-file tmp path so
// this test can't race with any other test file (notably
// stop-checklist.test.ts, which also invokes triggerDebouncedRefresh
// and would otherwise share the repo's .claude/scripts/.qmd-refresh-
// sentinel). The hook reads QMD_REFRESH_SENTINEL when set.
let TMP_DIR = "";
let SENTINEL = "";

before(() => {
	TMP_DIR = mkdtempSync(join(tmpdir(), "qmd-refresh-integration-"));
	SENTINEL = join(TMP_DIR, ".qmd-refresh-sentinel");
});

after(() => {
	if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true });
});

// Used to build realistic absolute `file_path` fixtures for hook payloads.
const VAULT_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

const runHook = (stdin: string | object | null) =>
	spawnHook(SCRIPT, stdin, { QMD_REFRESH_SENTINEL: SENTINEL });

function clearSentinel(): void {
	try {
		rmSync(SENTINEL, { force: true });
	} catch {
		/* ignored */
	}
}

function sentinelMtime(): number | null {
	try {
		return statSync(SENTINEL).mtimeMs;
	} catch {
		return null;
	}
}

function makeStaleSentinel(minutesAgo: number): void {
	// Create a sentinel whose mtime is outside the debounce window, so
	// "not debounced" paths can be asserted deterministically.
	writeFileSync(SENTINEL, "");
	// utimesSync accepts seconds-since-epoch for both atime and mtime
	// on every platform.
	const staleSec = (Date.now() - minutesAgo * 60_000) / 1000;
	utimesSync(SENTINEL, staleSec, staleSec);
}

// Every test starts from a clean slate.
beforeEach(() => {
	clearSentinel();
});

// --- Silent no-op paths (must not touch the sentinel) ---
describe("validate-write refresh trigger — silent no-op on ineligible inputs", () => {
	test("empty stdin exits 0 silently without touching sentinel", () => {
		const { stdout, stderr, code } = runHook(null);
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("malformed JSON exits 0 silently", () => {
		const { stdout, stderr, code } = runHook("not json {{{");
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("missing tool_input exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("null tool_input exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({ tool_input: null });
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("non-string file_path exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({
			tool_input: { file_path: 42 },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("non-markdown path exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({
			tool_input: { file_path: "/vault/work/active/note.txt" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test(".git path exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({
			tool_input: { file_path: "/vault/.git/HEAD.md" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test(".obsidian path exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({
			tool_input: { file_path: "/vault/.obsidian/workspace.md" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("node_modules path exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({
			tool_input: {
				file_path: "/vault/.claude/scripts/node_modules/foo/README.md",
			},
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("Windows-form skip path exits 0 silently", () => {
		const { stdout, stderr, code } = runHook({
			tool_input: { file_path: "C:\\vault\\.git\\info\\note.md" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});
});

// --- Debounce path (sentinel controls whether worker is spawned) ---
describe("validate-write refresh trigger — debounce", () => {
	test("fresh sentinel blocks a subsequent trigger (sentinel unchanged)", () => {
		// Arrange: sentinel was just "touched" (mtime = now).
		writeFileSync(SENTINEL, "");
		const before = sentinelMtime();
		assert.ok(before !== null, "sentinel should exist after writeFileSync");

		const { stdout, stderr, code } = runHook({
			tool_input: { file_path: join(VAULT_ROOT, "work/active/note.md") },
		});

		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		// A debounced run must not bump the sentinel mtime; the whole
		// point is that a burst of writes only spawns one worker per
		// window.
		assert.equal(sentinelMtime(), before);
	});
});

// --- Happy path: qmd installed, eligible .md → sentinel gets touched ---
describe("validate-write refresh trigger — eligible .md path", () => {
	// Guard: these tests assert the sentinel gets bumped when qmd is
	// available. On a CI image without qmd, `resolveQmdEntry()` returns
	// null and the trigger correctly short-circuits BEFORE touching the
	// sentinel — we assert that alternate path explicitly so CI covers
	// both branches regardless of qmd presence.
	test("sentinel is bumped when qmd resolves; skipped otherwise", () => {
		const qmdAvailable = resolveQmdEntry() !== null;

		// Stale sentinel keeps the debounce branch inactive. 5 minutes
		// is well beyond the 30s debounce window the hook uses.
		makeStaleSentinel(5);
		const before = sentinelMtime();
		assert.ok(before !== null);

		const { stdout, code } = runHook({
			tool_input: { file_path: join(VAULT_ROOT, "work/active/note.md") },
		});
		const after = sentinelMtime();

		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.ok(after !== null, "sentinel should remain present");

		if (qmdAvailable) {
			assert.ok(
				after > before,
				`expected sentinel mtime to advance when qmd is installed; got before=${before}, after=${after}`,
			);
		} else {
			assert.equal(
				after,
				before,
				"sentinel must not be touched when qmd is not resolvable — the hook exits before touchSentinel()",
			);
		}
	});

	test("path skipped by validation (templates/) still triggers the refresh", () => {
		// The merge's ordering contract: the refresh trigger fires BEFORE
		// validate-write's skip ladder. templates/ is skipped by
		// shouldSkipFile but was always refreshed by the old standalone
		// hook — the sentinel must still move (when qmd resolves).
		const qmdAvailable = resolveQmdEntry() !== null;

		makeStaleSentinel(5);
		const before = sentinelMtime();
		assert.ok(before !== null);

		const { stdout, code } = runHook({
			tool_input: { file_path: join(VAULT_ROOT, "templates/x.md") },
		});
		const after = sentinelMtime();

		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.ok(after !== null, "sentinel should remain present");

		if (qmdAvailable) {
			assert.ok(
				after > before,
				"validation-skipped paths must still refresh the QMD index",
			);
		} else {
			assert.equal(after, before);
		}
	});
});
