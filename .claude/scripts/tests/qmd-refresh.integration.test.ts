/**
 * Subprocess integration tests for the qmd-refresh.ts PostToolUse hook.
 *
 * Exercises the real stdin → decision → sentinel pipeline by spawning
 * the hook entry script exactly the way each agent's settings.json
 * would: `node --experimental-strip-types qmd-refresh.ts` with a JSON
 * payload on stdin. The sentinel file is the only observable the hook
 * produces (stdout must stay silent), so each test asserts on sentinel
 * presence / mtime + exit code.
 *
 * Deliberately does NOT depend on qmd being installed. The hook's
 * short-circuit when `resolveQmdEntry()` returns null means the
 * "sentinel NOT touched" path still runs cleanly on a minimal CI image
 * without polluting anyone's QMD cache. The qmd-installed path is
 * handled by one guarded test that checks `resolveQmdEntry()` directly
 * and skips itself when qmd isn't available.
 *
 * Runs identically on Windows, macOS, and Linux — the hook's
 * cross-platform shape is asserted through the same spawn mechanism
 * that powers validate-write.test.ts and stop-checklist.test.ts.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
	existsSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { runScript as spawnHook } from "./_helpers.ts";
import { resolveQmdEntry } from "../lib/qmd.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(SCRIPT_DIR, "../qmd-refresh.ts");
const SENTINEL = resolve(SCRIPT_DIR, "..", ".qmd-refresh-sentinel");

// Worker path for post-test reap. When qmd IS installed, the hook will
// detach a real worker that reads the repo manifest and runs `qmd update`
// + `qmd embed` against the configured index. That's fine on a dev
// machine but we want to avoid test output pollution — the detached
// worker's stdio is 'ignore'd, so no output reaches node --test anyway.
const VAULT_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

const runHook = (stdin: string | object | null) => spawnHook(SCRIPT, stdin);

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

// Every test starts from a clean slate — the repo's `.qmd-refresh-sentinel`
// is gitignored, so we're free to mutate it.
beforeEach(() => {
	clearSentinel();
});

// Restore known state after the suite so interactive sessions (or a
// subsequent `npm test` run) don't accidentally debounce their first
// real refresh against a stale test sentinel.
after(() => {
	clearSentinel();
});

// --- Silent no-op paths (must not touch the sentinel) ---
describe("qmd-refresh — silent no-op on ineligible inputs", () => {
	test("empty stdin exits 0 silently without touching sentinel", () => {
		const { stdout, stderr, code } = runHook(null);
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(stderr, "");
		assert.equal(sentinelMtime(), null);
	});

	test("malformed JSON exits 0 silently", () => {
		const { stdout, code } = runHook("not json {{{");
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test("missing tool_input exits 0 silently", () => {
		const { stdout, code } = runHook({});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test("null tool_input exits 0 silently", () => {
		const { stdout, code } = runHook({ tool_input: null });
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test("non-string file_path exits 0 silently", () => {
		const { stdout, code } = runHook({ tool_input: { file_path: 42 } });
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test("non-markdown path exits 0 silently", () => {
		const { stdout, code } = runHook({
			tool_input: { file_path: "/vault/work/active/note.txt" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test(".git path exits 0 silently", () => {
		const { stdout, code } = runHook({
			tool_input: { file_path: "/vault/.git/HEAD.md" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test(".obsidian path exits 0 silently", () => {
		const { stdout, code } = runHook({
			tool_input: { file_path: "/vault/.obsidian/workspace.md" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test("node_modules path exits 0 silently", () => {
		const { stdout, code } = runHook({
			tool_input: {
				file_path: "/vault/.claude/scripts/node_modules/foo/README.md",
			},
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});

	test("Windows-form skip path exits 0 silently", () => {
		const { stdout, code } = runHook({
			tool_input: { file_path: "C:\\vault\\.git\\info\\note.md" },
		});
		assert.equal(code, 0);
		assert.equal(stdout, "");
		assert.equal(sentinelMtime(), null);
	});
});

// --- Debounce path (sentinel controls whether worker is spawned) ---
describe("qmd-refresh — debounce", () => {
	test("fresh sentinel blocks a subsequent trigger (sentinel unchanged)", () => {
		// Arrange: sentinel was just "touched" (mtime = now).
		writeFileSync(SENTINEL, "");
		const before = sentinelMtime();
		assert.ok(before !== null, "sentinel should exist after writeFileSync");

		const { stdout, code } = runHook({
			tool_input: { file_path: join(VAULT_ROOT, "work/active/note.md") },
		});

		assert.equal(code, 0);
		assert.equal(stdout, "");
		// A debounced run must not bump the sentinel mtime; the whole
		// point is that a burst of writes only spawns one worker per
		// window.
		assert.equal(sentinelMtime(), before);
	});
});

// --- Happy path: qmd installed, eligible .md → sentinel gets touched ---
describe("qmd-refresh — eligible .md path", () => {
	// Guard: this test asserts the sentinel gets bumped when qmd is
	// available. On a CI image without qmd, `resolveQmdEntry()` returns
	// null and the hook correctly short-circuits BEFORE touching the
	// sentinel — we assert that alternate path explicitly below so CI
	// covers both branches regardless of qmd presence.
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
});

// --- Harness sanity: entrypoint must exist (catches a moved script path) ---
describe("qmd-refresh — script layout", () => {
	before(() => {
		assert.ok(
			existsSync(SCRIPT),
			`qmd-refresh.ts not found at expected path: ${SCRIPT}`,
		);
	});
	test("entry script is present", () => {
		assert.ok(existsSync(SCRIPT));
	});
});
