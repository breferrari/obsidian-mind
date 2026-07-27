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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
	resolveReasonConfig,
	reasonUsage,
	reasonAuditDetail,
	reasoningArgs,
	reasoningPrompt,
	hasEvidence,
	visibleHits,
	interpretRun,
	renderReasoningRecord,
	resolveClaudeCommand,
	writeIsolatedMcpConfig,
	writeIsolatedMcpConfigPath,
	writeReasoningRecord,
	describeRefusal,
	REASON_ACTION,
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

/** A completed run. Tests override only the field they are about. */
const result = (over: Partial<ReasoningResult> = {}): ReasoningResult => ({
	ok: true,
	answer: "the answer",
	costUsd: 0.12,
	turns: 5,
	modelUsed: "claude-haiku-4-5",
	terminal: "completed",
	wallMs: 21_000,
	error: null,
	...over,
});

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
		assert.equal(resolveReasonConfig({}).model, null);
		// And the argv agrees — the default is one fact, not a constant that a
		// second code path could disagree with.
		assert.ok(!reasoningArgs(resolveReasonConfig({}), "q", "c.json").includes("--model"));
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

describe("the daily usage line health reports", () => {
	// The sum itself is `sumAuditField`'s job and is tested against the writer in
	// mcp-caller.test.ts, including rotation. Here: the line this tool composes
	// from it, with the read injected so no log is needed.
	const spend = (total: number, complete = true) => () => ({ total, complete });

	test("names the model a call would actually use", () => {
		assert.match(reasonUsage("/v", {}, "2026-07-27", spend(0)), /model: your CLI default/);
		assert.match(
			reasonUsage("/v", { reason: { model: "claude-opus-4-6" } }, "2026-07-27", spend(0)),
			/model: claude-opus-4-6/,
		);
	});

	test("says so explicitly when nothing has run, rather than reporting $0", () => {
		// An absent or zeroed line reads as "not tracked", and this line is the
		// whole of the answer to where usage went.
		assert.match(reasonUsage("/v", {}, "2026-07-27", spend(0)), /nothing yet today/);
	});

	test("reports the day's total when there is one", () => {
		assert.match(reasonUsage("/v", {}, "2026-07-27", spend(0.3512)), /\$0\.3512 reported/);
	});

	test("says AT LEAST when the log was too large to read whole", () => {
		// A silently-low figure is the failure to avoid: this line is the entire
		// answer to where usage went, and it degrades exactly on the busiest days,
		// so it has to admit being a floor rather than present one as a total.
		assert.match(reasonUsage("/v", {}, "2026-07-27", spend(0.5, false)), /at least \$0\.5000/);
		// And a truncated read with nothing found is not the same as "nothing ran".
		assert.match(reasonUsage("/v", {}, "2026-07-27", spend(0, false)), /readable tail/);
	});

	test("asks the log for this tool's own action key", () => {
		// The stamp and the read must move together; a rename on one side only
		// makes the figure read zero forever, which looks like "no calls today".
		let askedFor = "";
		reasonUsage("/v", {}, "2026-07-27", (_root, action, _day, field) => {
			askedFor = `${action}/${field}`;
			return { total: 0, complete: true };
		});
		assert.equal(askedFor, `${REASON_ACTION}/cost_usd`);
	});
});

// ---------------------------------------------------------------------------
// The audit detail — written here, read here
// ---------------------------------------------------------------------------

describe("the audit detail for a run", () => {
	test("records what the spawn was TOLD it could read", () => {
		// The boundary is observed by the spawn, not enforced by the filesystem,
		// so the log is the only place it stays answerable afterwards.
		const d = reasonAuditDetail("q", resolveReasonConfig({}), result(), {
			roots: ["brain", "reference"],
			memoryRoot: "memories",
			neverExpose: [],
		});
		assert.equal(d.roots, "brain,reference");
	});

	test("a very long question is truncated in the LOG, not refused", () => {
		// One entry bigger than the log's read window leaves nothing parseable in
		// it, and the day's usage then reports a confident zero. What may be ASKED
		// is not capped — only what is written beside every other call's record.
		const d = reasonAuditDetail("x".repeat(50_000), resolveReasonConfig({}), result(), undefined);
		assert.ok(String(d.question).length < 4000, `audit line kept ${String(d.question).length} chars`);
		assert.match(String(d.question), /…$/);
	});

	test("says vault-wide when no boundary was given, rather than omitting it", () => {
		const d = reasonAuditDetail("q", resolveReasonConfig({}), result(), undefined);
		assert.equal(d.roots, "vault-wide");
	});

	test("separates the model asked for from the model that ran", () => {
		const d = reasonAuditDetail("q", resolveReasonConfig({ reason: { model: "claude-opus-4-6" } }), result(), undefined);
		assert.equal(d.model_asked, "claude-opus-4-6");
		assert.equal(d.model_used, "claude-haiku-4-5");
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

	test("only qmd's own failure prose reads as an empty seed", () => {
		// The sentinels are PREFIXES. A retrieved passage that happens to quote one
		// of those phrases is still evidence, and must not flip the branch.
		assert.ok(hasEvidence("[1] brain/Search.md — logs 'no results' when the index is cold"));
		assert.ok(!hasEvidence("(no results visible to this repo; 3 match(es) withheld as out of scope)"));
	});

	test("the permitted count decides, not what qmd returned before filtering", () => {
		// `total` counts hits BEFORE the exposure policy filtered them, so a search
		// whose every hit was withheld has total > 0 and nothing the spawn can see.
		// Reading `total` alone would hand it an empty evidence block — the exact
		// shape that produced the false-absence answer above.
		assert.equal(visibleHits({ total: 5, withheld: 5 }), 0);
		assert.equal(visibleHits({ total: 5, withheld: 2 }), 3);
		assert.equal(visibleHits({ total: 0, withheld: 0 }), 0);
	});
});

describe("the read boundary in the prompt", () => {
	const scope = { roots: ["brain", "reference"], memoryRoot: "memories", neverExpose: [] };

	test("names the exposed roots as a prohibition, not a suggestion", () => {
		// `--tools Read,Grep,Glob` with cwd at the vault root gives the spawn the
		// whole tree, while its seed came through the exposure policy. A prohibition
		// is the form measured to propagate into a session; a positive "consult X"
		// is advisory and gets skipped whenever something nearer answers.
		const p = reasoningPrompt("q", "PASSAGE", scope);
		assert.match(p, /Read ONLY within these folders: brain, reference/);
		assert.match(p, /Do not read anything/i);
	});

	test("keeps the memory root and .claude out, whatever the roots say", () => {
		// A spawn reading memories/ directly sees every caller's, not its own —
		// and "memories are never served as an ordinary note" holds regardless of
		// configuration everywhere else in this layer. `.claude/` holds the audit
		// log, which is every caller's query text.
		const p = reasoningPrompt("q", "PASSAGE", scope);
		assert.match(p, /Never read memories\//);
		assert.match(p, /\.claude\//);
	});

	test("states ALL THREE of the policy's rules, not just the folders", () => {
		// never-expose filenames and `private:` notes live INSIDE exposed roots, so
		// a boundary naming only folders grants exactly the files the other two
		// rules exist to withhold. Demonstrated: with roots ["brain"], a spawn was
		// permitted brain/SOUL.md (never-expose) and a private-tagged note.
		const p = reasoningPrompt("q", "PASSAGE", {
			roots: ["brain"],
			memoryRoot: "memories",
			neverExpose: ["SOUL.md", "Memories.md"],
		});
		assert.match(p, /Never read any file named: SOUL\.md, Memories\.md/);
		assert.match(p, /private/i);
	});

	test("applies to the unseeded branch too", () => {
		// The empty-seed branch tells the spawn to go read the tree itself, so it is
		// the branch where an unbounded read is most likely.
		const p = reasoningPrompt("q", "", scope);
		assert.match(p, /Read ONLY within these folders/);
		assert.match(p, /read it directly/i);
	});

	test("no scope means no fabricated boundary", () => {
		assert.ok(!reasoningPrompt("q", "PASSAGE").includes("Read ONLY"));
	});

	test("empty roots DENY rather than permit", () => {
		// `resolveExposure` strips the memory root from whatever was declared, so a
		// vault exposing only its memories resolves to an empty list. An empty list
		// that produced no prohibition would hand the spawn the run of the vault at
		// exactly the moment the config said to serve almost none of it.
		const p = reasoningPrompt("q", "PASSAGE", { roots: [], memoryRoot: "memories", neverExpose: [] });
		assert.match(p, /Do not read the note tree at all/);
		assert.match(p, /Never read memories\//);
	});
});


// ---------------------------------------------------------------------------
// Reading a finished run — the half that used to be unreachable
// ---------------------------------------------------------------------------

describe("interpreting a finished run", () => {
	const json = (o: Record<string, unknown>) => JSON.stringify(o);

	test("a completed run carries its answer and telemetry", () => {
		const r = interpretRun(
			json({
				result: "because of X",
				num_turns: 4,
				total_cost_usd: 0.42,
				terminal_reason: "completed",
				modelUsage: { "claude-opus-5": {} },
			}),
			"",
			null,
			16_000,
		);
		assert.equal(r.ok, true);
		assert.equal(r.answer, "because of X");
		assert.equal(r.turns, 4);
		assert.equal(r.costUsd, 0.42);
		assert.equal(r.modelUsed, "claude-opus-5");
		assert.equal(r.wallMs, 16_000);
		assert.equal(r.error, null);
	});

	test("is_error is NOT ok, even with a result string present", () => {
		// This is the flag gating the "no answer, refused by name" path. A run that
		// stopped early must never be handed back as a complete answer.
		const r = interpretRun(json({ is_error: true, result: "partial…", terminal_reason: "budget_exhausted" }), "", null, 5);
		assert.equal(r.ok, false);
		assert.equal(r.terminal, "budget_exhausted");
	});

	test("a non-JSON body reports whatever the CLI printed", () => {
		const r = interpretRun("Usage: claude [options]", "", null, 5);
		assert.equal(r.ok, false);
		assert.equal(r.terminal, "spawn_failed");
		assert.match(String(r.error), /Usage: claude/);
	});

	test("stderr is used when stdout is empty", () => {
		const r = interpretRun("", "command not found", null, 5);
		assert.match(String(r.error), /command not found/);
	});

	test("a spawn error outranks the output, because it explains it", () => {
		const r = interpretRun("", "", "spawn claude ENOENT", 5);
		assert.match(String(r.error), /ENOENT/);
	});

	test("a spawn error still wins when the body happens to parse", () => {
		const r = interpretRun(json({ result: "x" }), "", "spawn claude ENOENT", 5);
		assert.equal(r.ok, false);
		assert.match(String(r.error), /ENOENT/);
	});

	test("silence reports as silence rather than as an empty answer", () => {
		assert.match(String(interpretRun("", "", null, 5).error), /no output/);
	});

	test("missing telemetry fields degrade to zero, never to NaN", () => {
		const r = interpretRun(json({ result: "x" }), "", null, 5);
		assert.equal(r.costUsd, 0);
		assert.equal(r.turns, 0);
		assert.equal(r.modelUsed, "unknown");
		assert.equal(r.terminal, "unknown");
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

	test("the isolated config is plumbing, kept out of the provenance directory", () => {
		// REASONING_DIR is user-facing — every answer names a record inside it — and
		// is otherwise a homogeneous set of timestamped transcripts. A config file
		// in there means any future list-or-prune needs a filename exception.
		withDir((dir) => {
			assert.ok(!writeIsolatedMcpConfig(dir).includes("om-reasoning"));
		});
	});

	test("the CLI can be pointed somewhere else, and the override wins", () => {
		// A CLI that is not on this process's PATH has no other way to be found.
		assert.deepEqual(resolveClaudeCommand({ OM_CLAUDE_BIN: "/opt/claude/bin/claude" }), {
			cmd: "/opt/claude/bin/claude",
			leading: [],
		});
		assert.deepEqual(resolveClaudeCommand({ OM_CLAUDE_BIN: "   " }), resolveClaudeCommand({}));
	});

	test("without an override it is spawnable without a shell", () => {
		// Either the npm entry through this Node binary, or the bare name for a
		// native install. Never a shell: the prompt is a JSON-bearing argument and
		// cmd.exe strips its quotes.
		const c = resolveClaudeCommand({});
		assert.ok(c.cmd === "claude" || c.cmd === process.execPath, c.cmd);
		// When it resolved the npm entry, that entry is the first argument.
		assert.equal(c.leading.length, c.cmd === process.execPath ? 1 : 0);
	});

	test("the record's text is assertable without touching disk", () => {
		// A spawned conclusion is reasoning, not verified knowledge. Recording it
		// as anything else is how a store fills with claims nobody checked.
		const md = renderReasoningRecord(new Date("2026-07-27T01:02:03Z"), "the question", result());
		assert.match(md, /confidence: inferred/);
		assert.match(md, /source: mcp-reason/);
		assert.match(md, /cost_usd: 0\.12/);
		assert.match(md, /date: 2026-07-27T01:02:03/);
		assert.match(md, /the question/);
		assert.match(md, /the answer/);
	});

	test("a record is written outside the vault's note tree", () => {
		withDir((dir) => {
			const rel = writeReasoningRecord(dir, new Date("2026-07-27T01:02:03Z"), "the question", result());
			assert.ok(rel, "a record path is returned");
			assert.ok(rel!.startsWith(REASONING_DIR), "kept beside the audit log, not filed as a note");
			assert.match(readFileSync(join(dir, rel!), "utf8"), /confidence: inferred/);
		});
	});

	test("losing the record does not lose the answer", () => {
		// The transcript is provenance, not the result.
		assert.equal(writeReasoningRecord("\0 not a path", new Date(), "q", result()), null);
	});

	test("two records stamped at the same instant BOTH survive", () => {
		// The stamp is millisecond-precision and reads as collision-proof, but
		// calls overlap now that the spawn is async, and one vault can have a
		// server per consuming repo. Under a plain write the loser silently
		// overwrote the winner while both reported success — the same shape that
		// made six processes produce four files in the memory layer.
		withDir((dir) => {
			const t = new Date("2026-07-27T10:00:00.123Z");
			const a = writeReasoningRecord(dir, t, "question A", result({ answer: "ANSWER-A" }));
			const b = writeReasoningRecord(dir, t, "question B", result({ answer: "ANSWER-B" }));
			assert.ok(a && b, "both calls report a path");
			assert.notEqual(a, b, "and the paths differ");
			const bodies = readdirSync(join(dir, REASONING_DIR))
				.filter((f) => f.endsWith(".md"))
				.map((f) => readFileSync(join(dir, REASONING_DIR, f), "utf8"));
			assert.equal(bodies.length, 2, "no answer was overwritten");
			assert.ok(bodies.some((s) => s.includes("ANSWER-A")));
			assert.ok(bodies.some((s) => s.includes("ANSWER-B")));
		});
	});

	test("the isolated config is never observable half-written", () => {
		// A plain write truncates first. With overlapping calls, one call's
		// truncate can land while another call's child is reading this exact path
		// — and what it would read is the recursion guard. Rewritten many times
		// here; the file must parse as a complete config after every one.
		withDir((dir) => {
			for (let i = 0; i < 25; i++) {
				const p = writeIsolatedMcpConfig(dir);
				assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { mcpServers: {} }, `rewrite ${i}`);
			}
			// And no temp files are left behind beside it.
			const strays = readdirSync(join(dir, ".claude")).filter((f) => f.includes(".tmp"));
			assert.deepEqual(strays, [], "temp files must not accumulate");
		});
	});

	test("the record directory is not inside the note tree", () => {
		// It must not be walked by visibleFiles, indexed, or served as a resource:
		// dot-directories are skipped by every read surface.
		assert.ok(REASONING_DIR.startsWith("."), REASONING_DIR);
	});

	test("both artefacts are actually gitignored, and the two places agree", () => {
		// Two sources of truth per path: the code decides where the file goes,
		// .gitignore decides whether it is tracked. Move one without the other and
		// a machine config, or a transcript of the user's own questions and the
		// answers to them, starts appearing in commits.
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
		const ignored = readFileSync(join(repoRoot, ".gitignore"), "utf8")
			.split(/\r?\n/)
			.map((l) => l.trim());
		const rel = (abs: string) => abs.slice("/v/".length).split(/[\\/]/).join("/");

		assert.ok(ignored.includes(`${REASONING_DIR}/`), `.gitignore must contain "${REASONING_DIR}/"`);

		// A trailing `*` is allowed and wanted: the config is created through a
		// `.tmp` sibling, which a crash between write and claim can leave behind.
		const cfg = rel(writeIsolatedMcpConfigPath("/v"));
		const covers = (line: string) => line === cfg || line === `${cfg}*`;
		assert.ok(
			ignored.some(covers),
			`.gitignore must contain "${cfg}" or "${cfg}*" — the path and the ignore rule have drifted`,
		);
		assert.ok(
			ignored.some((l) => l === `${cfg}*`),
			`"${cfg}*" is what also covers the .tmp sibling this file is created through`,
		);
	});
});

describe("refusals", () => {
	test("a refusal says what to change", () => {
		const r = describeRefusal("no question given.", "Ask the judgement you need, in full.");
		assert.match(r, /^Not run:/);
		assert.match(r, /Ask the judgement you need/);
	});
});
