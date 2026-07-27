/**
 * `reason` — the pure parts: config, prompt, argv, refusals, records.
 *
 * Nothing here spawns. Splitting the decisions out from the spawn is what lets
 * every one of them be driven by a test without starting a session to check it.
 *
 * The CLI facts pinned below were measured against the real binary first, and
 * every one of them contradicted the obvious guess:
 *   - `--max-turns` does not exist
 *   - `--model haiku` silently runs sonnet, so an alias is dropped, not passed
 *   - `--permission-mode plan` writes outside the vault AND rewrites the task as
 *     "produce a plan", losing the answer — so the toolset is restricted instead
 *   - an empty seed reads as evidence of absence unless the prompt says not to
 *   - an early end returns an EMPTY result, so there is nothing to mistake for
 *     an answer
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	resolveReasonConfig,
	spentToday,
	reasoningArgs,
	reasoningPrompt,
	hasEvidence,
	resolveClaudeBin,
	writeIsolatedMcpConfig,
	writeReasoningRecord,
	describeRefusal,
	REASON_DEFAULTS,
	REASONING_DIR,
	type ReasoningResult,
} from "../lib/mcp-reason.ts";

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "reason-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("resolving the reason config", () => {
	test("the config surface is exactly one key: model", () => {
		assert.deepEqual(Object.keys(resolveReasonConfig({})), ["model"]);
		// Unknown keys are inert rather than honoured — a manifest that asks for
		// something this tool does not have gets the same config as one that does
		// not ask. Pinned so the surface cannot quietly grow back.
		const c = resolveReasonConfig({
			reason: { max_usd_per_call: 0.05, max_usd_per_day: 0.05, enabled: false, timeout_ms: 5 },
		}) as unknown as Record<string, unknown>;
		assert.deepEqual(Object.keys(c), ["model"]);
	});

	test("no model is pinned by default, so the spawn follows the CLI", () => {
		// MCP does not tell a server what model the CALLER is using, so inheriting
		// the user's own CLI default is the closest reachable thing to "the same
		// model I am already working at".
		assert.equal(REASON_DEFAULTS.model, null);
		assert.equal(resolveReasonConfig({}).model, null);
	});

	test("a model ALIAS falls back to inheriting, never to a hardcoded id", () => {
		// Measured: `--model haiku` is not honoured and does not error — it runs
		// claude-sonnet-5. A pin that silently means something else is worse than
		// no pin, so an alias is dropped rather than passed on.
		for (const alias of ["haiku", "sonnet", "opus", "", "  "]) {
			assert.equal(resolveReasonConfig({ reason: { model: alias } }).model, null, alias);
		}
	});

	test("a full model id is honoured when a vault deliberately pins one", () => {
		assert.equal(resolveReasonConfig({ reason: { model: "claude-opus-4-6" } }).model, "claude-opus-4-6");
	});
});

// ---------------------------------------------------------------------------
// The daily ledger
// ---------------------------------------------------------------------------

describe("the daily usage figure health reports", () => {
	const entry = (o: Record<string, unknown>) => JSON.stringify(o);

	test("sums only today's reasoning, and gates nothing", () => {
		withDir((dir) => {
			const log = join(dir, "audit.jsonl");
			writeFileSync(
				log,
				[
					entry({ action: "reason", at: "2026-07-27T01:00:00Z", cost_usd: 0.1 }),
					entry({ action: "reason", at: "2026-07-27T02:00:00Z", cost_usd: 0.25 }),
					entry({ action: "reason", at: "2026-07-26T23:00:00Z", cost_usd: 99 }), // yesterday
					entry({ action: "search", at: "2026-07-27T03:00:00Z", cost_usd: 99 }), // not a spawn
					entry({ action: "recall", at: "2026-07-27T04:00:00Z" }),
				].join("\n"),
				"utf8",
			);
			assert.equal(Number(spentToday(log, "2026-07-27").toFixed(4)), 0.35);
		});
	});

	test("a missing log is zero, not a crash", () => {
		withDir((dir) => assert.equal(spentToday(join(dir, "nope.jsonl"), "2026-07-27"), 0));
	});

	test("a torn or hand-edited line is skipped, never fatal", () => {
		// This log is read for reporting, so a corrupt line may under-report — but
		// it must never throw and take `health` down with it.
		withDir((dir) => {
			const log = join(dir, "audit.jsonl");
			writeFileSync(
				log,
				[
					entry({ action: "reason", at: "2026-07-27T01:00:00Z", cost_usd: 0.1 }),
					'{"action":"reason","at":"2026-07-27T02:00:00Z","cost_usd":', // truncated
					"",
					"not json at all",
					entry({ action: "reason", at: "2026-07-27T03:00:00Z", cost_usd: "free" }),
					entry({ action: "reason", at: "2026-07-27T04:00:00Z", cost_usd: 0.2 }),
				].join("\n"),
				"utf8",
			);
			assert.equal(Number(spentToday(log, "2026-07-27").toFixed(4)), 0.3);
		});
	});
});

// ---------------------------------------------------------------------------
// The spawn's argv — asserted without spawning
// ---------------------------------------------------------------------------

describe("the spawn arguments", () => {
	const cfg = resolveReasonConfig({});
	const args = reasoningArgs(cfg, "the question", "C:/v/.claude/om-reasoning/no-mcp.json");
	const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];

	test("the argv is exactly these flags", () => {
		// Pinned as a whole set rather than flag by flag, so anything added here has
		// to be added here deliberately and read by a human first.
		assert.deepEqual(args.filter((a) => a.startsWith("--")), [
			"--output-format",
			"--strict-mcp-config",
			"--mcp-config",
			"--tools",
		]);
	});

	test("the recursion guard is present and complete", () => {
		// --strict-mcp-config alone is not enough; it needs the empty config to
		// point at, or the spawn keeps the ambient servers — including this one.
		assert.ok(args.includes("--strict-mcp-config"));
		assert.match(String(valueAfter("--mcp-config")), /no-mcp\.json$/);
	});

	test("the spawn is read-only and machine-readable", () => {
		// `--tools` restricts the built-in set itself, so a write comes back as
		// "No such tool available" rather than as a prompt nothing can answer.
		const tools = String(valueAfter("--tools")).split(",");
		assert.deepEqual(tools, ["Read", "Grep", "Glob"]);
		for (const w of ["Write", "Edit", "NotebookEdit", "Bash"]) {
			assert.ok(!tools.includes(w), `${w} must not be reachable from a reasoning pass`);
		}
		assert.equal(valueAfter("--output-format"), "json");
	});

	test("plan mode is never used, for two separate reasons", () => {
		// It writes the plan to ~/.claude/plans/ — outside the vault, so it is not
		// read-only — and it reframes the task as producing a plan for approval.
		// Measured: the spawn composed its analysis as a plan, could not hand it
		// back without ExitPlanMode, and returned a note about that instead of the
		// answer. Non-deterministic, so a passing run proves nothing; the flag goes.
		assert.ok(!args.includes("--permission-mode"), "no permission mode is set at all");
		assert.ok(!args.includes("plan"));
	});

	test("no --model flag at all unless the vault pinned one", () => {
		assert.ok(!args.includes("--model"), "an unpinned vault inherits the user's CLI default");
	});

	test("a pinned model reaches the spawn as a full id", () => {
		const pinned = reasoningArgs(
			resolveReasonConfig({ reason: { model: "claude-opus-4-6" } }),
			"q",
			"c.json",
		);
		assert.equal(pinned[pinned.indexOf("--model") + 1], "claude-opus-4-6");
	});
});

describe("the prompt", () => {
	const p = reasoningPrompt("why did we choose X", "PASSAGE-ONE\nPASSAGE-TWO");

	test("carries the question and the seeded evidence", () => {
		assert.match(p, /why did we choose X/);
		assert.match(p, /PASSAGE-ONE/);
		assert.match(p, /<evidence>/);
	});

	test("licenses the spawn to go beyond the seed", () => {
		// Measured: a seeded run leaned on its passages and repeated a framing the
		// vault had since corrected. Seeding saves about a turn and costs some
		// independence, so the instruction has to push back.
		assert.match(p, /starting point/i);
		assert.match(p, /read further/i);
	});

	test("asks for the vault's own epistemic markers to survive", () => {
		assert.match(p, /TBC/);
		assert.match(p, /inferred/);
	});

	test("an EMPTY seed is not presented as evidence of absence", () => {
		// Caught in a live run: handed an empty seed, the spawn answered "there are
		// no prior decisions recorded" about a question the vault answered in a note
		// one directory away. The index was simply not built. That is this layer's
		// signature failure — nothing found reading as nothing there — so the empty
		// case must tell the spawn to go and look.
		for (const empty of ["", "   ", "(no results)", "search failed: qmd unavailable", "(search unavailable: results could not be scope-checked)"]) {
			const q = reasoningPrompt("did we decide about caching", empty);
			assert.match(q, /NOT evidence that the vault is silent/i, JSON.stringify(empty));
			assert.match(q, /read it directly/i, JSON.stringify(empty));
			assert.ok(!q.includes("<evidence>"), "an empty evidence block invites the wrong inference");
			assert.match(q, /say how you looked/i, JSON.stringify(empty));
		}
	});

	test("a real seed is still passed as evidence", () => {
		assert.ok(hasEvidence("[1] brain/Caching.md  (score 91%)"));
		assert.ok(!hasEvidence("(no results)"));
		assert.match(reasoningPrompt("q", "[1] brain/Caching.md"), /<evidence>/);
	});
});

// ---------------------------------------------------------------------------
// Isolation and provenance
// ---------------------------------------------------------------------------

describe("isolation and provenance", () => {
	test("the isolated MCP config declares no servers at all", () => {
		withDir((dir) => {
			const p = writeIsolatedMcpConfig(dir);
			assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { mcpServers: {} });
		});
	});

	test("the binary can be pointed somewhere else", () => {
		// A CLI that is not on this process's PATH has no other way to be found.
		assert.equal(resolveClaudeBin({}), "claude");
		assert.equal(resolveClaudeBin({ OM_CLAUDE_BIN: "/opt/claude/bin/claude" }), "/opt/claude/bin/claude");
		assert.equal(resolveClaudeBin({ OM_CLAUDE_BIN: "   " }), "claude");
	});

	test("a record is written outside the vault's note tree, marked inferred", () => {
		withDir((dir) => {
			const r: ReasoningResult = {
				ok: true,
				answer: "the answer",
				costUsd: 0.12,
				turns: 5,
				modelUsed: "claude-haiku-4-5",
				terminal: "completed",
				wallMs: 21_000,
				error: null,
			};
			const rel = writeReasoningRecord(dir, new Date("2026-07-27T01:02:03Z"), "the question", r);
			assert.ok(rel, "a record path is returned");
			assert.ok(rel!.startsWith(REASONING_DIR), "kept beside the audit log, not filed as a note");
			const md = readFileSync(join(dir, rel!), "utf8");
			// A spawned conclusion is reasoning, not verified knowledge. Recording it
			// as anything else is how a store fills with claims nobody checked.
			assert.match(md, /confidence: inferred/);
			assert.match(md, /source: mcp-reason/);
			assert.match(md, /cost_usd: 0\.12/);
			assert.match(md, /the question/);
			assert.match(md, /the answer/);
		});
	});

	test("losing the record does not lose the answer", () => {
		// The transcript is provenance, not the result.
		const r: ReasoningResult = {
			ok: true,
			answer: "a",
			costUsd: 0,
			turns: 1,
			modelUsed: "m",
			terminal: "completed",
			wallMs: 1,
			error: null,
		};
		assert.equal(writeReasoningRecord("\0 not a path", new Date(), "q", r), null);
	});

	test("the record directory is not inside the note tree", () => {
		// It must not be walked by visibleFiles, indexed, or served as a resource:
		// dot-directories are skipped by every read surface.
		assert.ok(REASONING_DIR.startsWith("."), REASONING_DIR);
	});
});

describe("refusals", () => {
	test("a refusal says what to change", () => {
		const r = describeRefusal("no question given.", "Ask the judgement you need, in full.");
		assert.match(r, /^Not run:/);
		assert.match(r, /Ask the judgement you need/);
	});
});
