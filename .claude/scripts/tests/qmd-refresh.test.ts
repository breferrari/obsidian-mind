/**
 * Unit tests for lib/qmd-refresh.ts pure helpers.
 *
 * Locks the predicates and composition logic the PostToolUse hook, the
 * Stop hook, and the detached worker all depend on. Pure tests run
 * identically on every OS in the CI matrix, so argv drift (wrong order,
 * missing `--index`, dropped subcommand) fails here before any live qmd
 * invocation would notice on macOS/Linux only.
 *
 * Subprocess integration coverage for the hook entry script lives in
 * `qmd-refresh.integration.test.ts` — both are exercised by
 * `npm test` in the hook-scripts package.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep as pathSep } from "node:path";
import {
	PENDING_GRACE_MS,
	claimTrailingFlush,
	composeWorkerInvocations,
	isDebounced,
	parseWorkerArgs,
	pendingPathFor,
	planRefresh,
	resolveVaultRoot,
	shouldRefreshForPath,
	triggerDebouncedRefresh,
} from "../lib/qmd-refresh.ts";
import { rmTemp } from "./_helpers.ts";

/**
 * The debounce used to fire on the leading edge only: a note written inside
 * the window after a refresh stayed unindexed until an unrelated trigger
 * landed outside it — for the last write of a session, until the next
 * SessionStart.
 */
describe("planRefresh — trailing edge", () => {
	const W = 30_000;
	test("outside the window → now", () => {
		assert.equal(planRefresh(null, null, 1_000_000, W), "now");
		assert.equal(planRefresh(1_000_000 - W, null, 1_000_000, W), "now");
	});
	test("inside the window, nothing owed → trailing", () => {
		assert.equal(planRefresh(1_000_000 - 10_000, null, 1_000_000, W), "trailing");
	});
	test("inside the window, a live flush owed → skip", () => {
		assert.equal(planRefresh(1_000_000 - 10_000, 1_000_000 - 5_000, 1_000_000, W), "skip");
	});
	test("a stale pending marker does not suppress the flush", () => {
		const now = 10_000_000;
		assert.equal(planRefresh(now - 10_000, now - (W + PENDING_GRACE_MS) - 1, now, W), "trailing");
	});
	test("a pending marker from the future is not trusted", () => {
		assert.equal(planRefresh(1_000_000 - 10_000, 1_000_000 + 5_000, 1_000_000, W), "trailing");
	});
});

describe("triggerDebouncedRefresh — schedules one trailing flush per window", () => {
	function fixture() {
		const dir = mkdtempSync(join(tmpdir(), "qmd-trailing-"));
		const sentinel = join(dir, ".qmd-refresh-sentinel");
		const spawned: (readonly string[])[] = [];
		const fire = () =>
			triggerDebouncedRefresh({
				sentinelPath: sentinel,
				workerPath: "worker.ts",
				debounceMs: 30_000,
				logPrefix: "test",
				qmdAvailable: () => true,
				spawnWorker: (_p, args) => spawned.push(args),
			});
		return { dir, sentinel, spawned, fire };
	}

	test("leading write runs now; a write inside the window schedules a trailing flush; a third is covered", () => {
		const f = fixture();
		try {
			f.fire();
			assert.deepEqual(f.spawned, [[]], "leading edge runs immediately");
			// Age the leading refresh to 10 s ago: two calls in the same
			// millisecond can see the sentinel's mtime a hair AHEAD of
			// Date.now(), which isDebounced deliberately reads as "not
			// debounced" (clock skew). Real hooks are separate processes.
			const t = (Date.now() - 10_000) / 1000;
			utimesSync(f.sentinel, t, t);
			f.fire();
			assert.equal(f.spawned.length, 2, "the in-window write must not be dropped");
			const args = f.spawned[1] as readonly string[];
			assert.ok(args.includes(`--trailing=${f.sentinel}`));
			const delay = Number(args.find((a) => a.startsWith("--delay-ms="))?.slice(11));
			assert.ok(delay > 0 && delay <= 30_000, `delay ${delay}`);
			assert.ok(existsSync(pendingPathFor(f.sentinel)));
			f.fire();
			assert.equal(f.spawned.length, 2, "one trailing worker per window, not one per write");
		} finally {
			rmTemp(f.dir);
		}
	});

	test("a stale pending marker is reclaimed", () => {
		const f = fixture();
		try {
			f.fire();
			const t = (Date.now() - 10_000) / 1000;
			utimesSync(f.sentinel, t, t);
			writeFileSync(pendingPathFor(f.sentinel), "");
			const old = (Date.now() - 30_000 - PENDING_GRACE_MS - 5_000) / 1000;
			utimesSync(pendingPathFor(f.sentinel), old, old);
			f.fire();
			assert.equal(f.spawned.length, 2);
		} finally {
			rmTemp(f.dir);
		}
	});
});

describe("claimTrailingFlush — the worker's gate after sleeping", () => {
	test("runs when no newer refresh started, clears the marker, stamps the sentinel", () => {
		const dir = mkdtempSync(join(tmpdir(), "qmd-claim-"));
		try {
			const s = join(dir, "s");
			writeFileSync(s, "");
			const t = (Date.now() - 40_000) / 1000;
			utimesSync(s, t, t);
			const after = statSync(s).mtimeMs;
			writeFileSync(pendingPathFor(s), "");
			assert.equal(claimTrailingFlush(s, after), true);
			assert.equal(existsSync(pendingPathFor(s)), false);
			assert.ok(statSync(s).mtimeMs > after);
		} finally {
			rmTemp(dir);
		}
	});

	test("skips when a newer refresh already stamped the sentinel, still clearing the marker", () => {
		const dir = mkdtempSync(join(tmpdir(), "qmd-claim-"));
		try {
			const s = join(dir, "s");
			writeFileSync(s, "");
			writeFileSync(pendingPathFor(s), "");
			const after = statSync(s).mtimeMs - 10_000;
			assert.equal(claimTrailingFlush(s, after), false);
			assert.equal(existsSync(pendingPathFor(s)), false);
		} finally {
			rmTemp(dir);
		}
	});
});

describe("parseWorkerArgs", () => {
	test("no trailing args → an immediate run", () => {
		assert.deepEqual(parseWorkerArgs([]), { trailing: null });
	});
	test("trailing args parse, and the delay is capped", () => {
		const p = parseWorkerArgs(["--trailing=/v/s", "--delay-ms=999999", "--after=123"]);
		assert.deepEqual(p.trailing, { delayMs: 120_000, sentinelPath: "/v/s", afterMs: 123 });
	});
	test("an empty --after means no prior sentinel", () => {
		assert.equal(parseWorkerArgs(["--trailing=/v/s", "--delay-ms=5", "--after="]).trailing?.afterMs, null);
	});
	test("a malformed delay falls back to an immediate run", () => {
		assert.deepEqual(parseWorkerArgs(["--trailing=/v/s", "--delay-ms=abc"]), { trailing: null });
	});
});

describe("shouldRefreshForPath — accepts vault markdown", () => {
	test("accepts a relative vault note", () => {
		assert.equal(shouldRefreshForPath("work/active/project.md"), true);
	});
	test("accepts an absolute Unix vault note", () => {
		assert.equal(
			shouldRefreshForPath("/Users/me/vault/work/active/project.md"),
			true,
		);
	});
	test("accepts an absolute Windows vault note", () => {
		assert.equal(
			shouldRefreshForPath("C:\\Users\\me\\vault\\work\\active\\project.md"),
			true,
		);
	});
	test("accepts a Windows UNC path", () => {
		assert.equal(
			shouldRefreshForPath("\\\\server\\share\\vault\\note.md"),
			true,
		);
	});
	test("accepts uppercase .MD extension", () => {
		assert.equal(shouldRefreshForPath("work/active/project.MD"), true);
	});
	test("accepts brain/, org/, perf/ paths (vault content roots)", () => {
		assert.equal(shouldRefreshForPath("brain/Patterns.md"), true);
		assert.equal(shouldRefreshForPath("org/people/Alice.md"), true);
		assert.equal(shouldRefreshForPath("perf/Brag Doc.md"), true);
	});
	test("accepts paths with spaces (Obsidian-style filenames)", () => {
		assert.equal(shouldRefreshForPath("work/1-1/Jane Smith 2026-04-05.md"), true);
	});
});

describe("shouldRefreshForPath — rejects non-markdown writes", () => {
	test("rejects empty path", () => {
		assert.equal(shouldRefreshForPath(""), false);
	});
	test("rejects non-string (defensive)", () => {
		// Function takes `unknown` so the runtime narrowing is the type
		// guard for downstream — no escape hatch needed in callers or tests.
		assert.equal(shouldRefreshForPath(undefined), false);
		assert.equal(shouldRefreshForPath(null), false);
		assert.equal(shouldRefreshForPath(42), false);
		assert.equal(shouldRefreshForPath({}), false);
		assert.equal(shouldRefreshForPath([]), false);
	});
	test("rejects .txt, .json, .ts, .yaml", () => {
		assert.equal(shouldRefreshForPath("work/note.txt"), false);
		assert.equal(shouldRefreshForPath("vault-manifest.json"), false);
		assert.equal(shouldRefreshForPath(".claude/scripts/foo.ts"), false);
		assert.equal(shouldRefreshForPath("config.yaml"), false);
	});
	test("rejects .mdx (not qmd's `**/*.md` pattern)", () => {
		assert.equal(shouldRefreshForPath("page.mdx"), false);
	});
	test("rejects extensionless paths", () => {
		assert.equal(shouldRefreshForPath("Makefile"), false);
		assert.equal(shouldRefreshForPath("LICENSE"), false);
	});
});

describe("shouldRefreshForPath — rejects skip-segment paths", () => {
	test("rejects .git internals", () => {
		assert.equal(shouldRefreshForPath(".git/COMMIT_EDITMSG.md"), false);
		assert.equal(
			shouldRefreshForPath("/Users/me/vault/.git/info/exclude.md"),
			false,
		);
	});
	test("rejects .obsidian config", () => {
		assert.equal(shouldRefreshForPath(".obsidian/workspace.md"), false);
		assert.equal(
			shouldRefreshForPath("/vault/.obsidian/plugins/foo/README.md"),
			false,
		);
	});
	test("rejects node_modules trees", () => {
		assert.equal(
			shouldRefreshForPath(".claude/scripts/node_modules/foo/README.md"),
			false,
		);
		assert.equal(
			shouldRefreshForPath("/vault/node_modules/pkg/CHANGELOG.md"),
			false,
		);
	});
	test("rejects Windows-form skip paths (backslash normalization)", () => {
		assert.equal(
			shouldRefreshForPath("C:\\vault\\.git\\info\\note.md"),
			false,
		);
		assert.equal(
			shouldRefreshForPath("C:\\vault\\.obsidian\\workspace.md"),
			false,
		);
		assert.equal(
			shouldRefreshForPath(
				"C:\\vault\\.claude\\scripts\\node_modules\\pkg\\README.md",
			),
			false,
		);
	});
	test("segment-boundary enforcement — .github does NOT match .git", () => {
		assert.equal(
			shouldRefreshForPath(".github/ISSUE_TEMPLATE.md"),
			true,
		);
	});
	test("segment-boundary enforcement — node_modules_backup does NOT match", () => {
		assert.equal(
			shouldRefreshForPath("archive/node_modules_backup_docs.md"),
			true,
		);
	});
});

describe("isDebounced — fresh sentinel", () => {
	test("returns true when elapsed < debounce window", () => {
		assert.equal(isDebounced(1_000, 1_500, 30_000), true);
	});
	test("returns true at the very start of the window (0ms elapsed)", () => {
		assert.equal(isDebounced(1_000, 1_000, 30_000), true);
	});
	test("returns false exactly at the debounce boundary", () => {
		assert.equal(isDebounced(1_000, 31_000, 30_000), false);
	});
	test("returns false when elapsed exceeds window", () => {
		assert.equal(isDebounced(1_000, 60_000, 30_000), false);
	});
});

describe("isDebounced — absent or invalid sentinel", () => {
	test("returns false when sentinel doesn't exist (null mtime)", () => {
		assert.equal(isDebounced(null, 1_000, 30_000), false);
	});
	test("returns false on negative elapsed (clock skew backwards)", () => {
		// Safer failure mode: wall-clock going backwards should not wedge
		// the refresh indefinitely.
		assert.equal(isDebounced(10_000, 5_000, 30_000), false);
	});
	test("returns false when debounce window is zero", () => {
		assert.equal(isDebounced(1_000, 1_000, 0), false);
	});
});

describe("resolveVaultRoot", () => {
	// These tests compare `resolveVaultRoot` output to the platform's own
	// `path.resolve` output on the expected vault root. Using resolvePath
	// on both sides dodges Windows's drive-letter prepending (e.g.
	// `/vault/.claude/scripts` becomes `D:\vault\.claude\scripts`) that
	// tripped up an earlier version of these tests on the CI matrix.
	test("strips the .claude/scripts suffix from an absolute input", () => {
		const result = resolveVaultRoot(
			resolvePath("/Users/me/vault/.claude/scripts"),
		);
		assert.equal(result, resolvePath("/Users/me/vault"));
	});
	test("handles a trailing separator gracefully", () => {
		const result = resolveVaultRoot(
			resolvePath("/vault/.claude/scripts") + pathSep,
		);
		assert.equal(result, resolvePath("/vault"));
	});
	test("always returns an absolute path (path.resolve guarantees this)", () => {
		// Relative inputs get resolved against cwd; we only assert
		// absoluteness here — the suffix-stripping semantics are locked
		// by the absolute-input test above.
		const result = resolveVaultRoot("a/b/.claude/scripts");
		const isAbsolute =
			/^[A-Za-z]:[\\/]/.test(result) ||
			result.startsWith("\\\\") ||
			result.startsWith("/");
		assert.ok(isAbsolute, `expected absolute path, got: ${result}`);
	});
});

describe("composeWorkerInvocations", () => {
	test("returns update, embed, and a tail-chase update in that order", () => {
		const invs = composeWorkerInvocations(
			"obsidian-mind",
			"/opt/qmd/qmd.js",
		);
		assert.equal(invs.length, 3);
		assert.ok(invs[0]?.args.includes("update"));
		assert.ok(invs[1]?.args.includes("embed"));
		assert.ok(invs[2]?.args.includes("update"));
		// The tail-chase step must NOT be an embed — keeping the worker
		// bounded means we accept one cycle of vec-staleness for
		// tail-landed content.
		assert.equal(invs[2]?.args.includes("embed"), false);
	});

	test("threads --index <name> through every invocation when set", () => {
		const invs = composeWorkerInvocations("vault-2", "/opt/qmd/qmd.js");
		for (const inv of invs) {
			assert.deepEqual(
				inv.args.slice(0, 3),
				["/opt/qmd/qmd.js", "--index", "vault-2"],
				`expected --index vault-2 to precede the subcommand in ${inv.args.join(" ")}`,
			);
		}
		assert.equal(invs[0]?.args.at(-1), "update");
		assert.equal(invs[1]?.args.at(-1), "embed");
		assert.equal(invs[2]?.args.at(-1), "update");
	});

	test("omits --index when qmdIndex is null (legacy / pre-named fork)", () => {
		const invs = composeWorkerInvocations(null, "/opt/qmd/qmd.js");
		for (const inv of invs) {
			assert.equal(inv.args.includes("--index"), false);
		}
		assert.deepEqual(invs[0]?.args, ["/opt/qmd/qmd.js", "update"]);
		assert.deepEqual(invs[1]?.args, ["/opt/qmd/qmd.js", "embed"]);
		assert.deepEqual(invs[2]?.args, ["/opt/qmd/qmd.js", "update"]);
	});

	test("every invocation goes through process.execPath when entry resolves", () => {
		const invs = composeWorkerInvocations("v", "/opt/qmd/qmd.js");
		for (const inv of invs) {
			assert.equal(inv.cmd, process.execPath);
			assert.equal(inv.shell, false);
		}
	});

	test("falls back to single-string `qmd …` shell command when entry is null", () => {
		// Args fold into cmd at build time so the spawn site uses shell:true
		// WITHOUT args — Node 24's DEP0190 only fires on the deprecated
		// args+shell concatenation pattern.
		const invs = composeWorkerInvocations("v", null);
		const subcommands = ["update", "embed", "update"];
		invs.forEach((inv, i) => {
			assert.equal(inv.cmd, `qmd --index v ${subcommands[i]}`);
			assert.deepEqual(inv.args, []);
			assert.equal(inv.shell, true);
		});
	});

	test("fallback preserves --index threading across all steps", () => {
		const invs = composeWorkerInvocations("vault-2", null);
		assert.equal(invs[0]?.cmd, "qmd --index vault-2 update");
		assert.equal(invs[1]?.cmd, "qmd --index vault-2 embed");
		assert.equal(invs[2]?.cmd, "qmd --index vault-2 update");
		for (const inv of invs) {
			assert.deepEqual(inv.args, []);
		}
	});

	test("embed gets a longer budget than update (model download slot)", () => {
		const [update, embed, tail] = composeWorkerInvocations("v", "/opt/qmd.js");
		assert.ok(
			update && embed && tail && embed.timeoutMs > update.timeoutMs,
			`embed budget (${embed?.timeoutMs}) must exceed update budget (${update?.timeoutMs})`,
		);
		// Tail-chase update reuses the leading update's budget — same
		// subcommand, same time shape.
		assert.equal(tail?.timeoutMs, update?.timeoutMs);
	});
});
