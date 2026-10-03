/**
 * Integration tests for the shared Stop/SessionEnd hook entry point.
 * Locks the once-per-session Stop report, the always-on SessionEnd report,
 * stop_hook_active semantics, and the JSON output envelope.
 *
 * Why Stop dedupes instead of moving to SessionEnd (#252): Stop fires after
 * every response on Claude Code and Codex, so an unconditional report repeats
 * unchanged drift on every turn. SessionEnd cannot carry it there instead —
 * Claude Code discards a SessionEnd hook's `systemMessage`, and Codex does
 * not list SessionEnd among the events whose `systemMessage` it surfaces.
 * So Stop reports once per session and again only when the report changes;
 * SessionEnd (Gemini's wiring) reports every time.
 *
 * The envelope matters more than it looks. Session-boundary stdout is
 * JSON-or-nothing on all three agents, and each one fails differently when
 * it isn't: Codex reports a hook failure, Gemini ignores the output, and
 * Claude Code files it in the debug log — silently, which is why plain text
 * survived here so long. These tests parse stdout rather than regex-matching
 * it, so a regression back to plain text fails instead of passing on a
 * substring that appears inside the JSON either way.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HOOK_OUTPUT_MAX_CHARS } from "../lib/hook-io.ts";
import { takeHandoff } from "../lib/stop-handoff.ts";
import { AGENT_PREFACE, FEEDBACK_PREFACE, FEEDBACK_TRAILER, MOD_PREFACE, SUMMARY_TRAILER } from "../lib/stop-report.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runScript as spawnHook, rmTemp } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../stop-checklist.ts",
);
const CLASSIFY = resolve(dirname(fileURLToPath(import.meta.url)), "../classify-message.ts");

// Route the debounce sentinel through a per-file tmp path. Every run of this
// hook calls triggerDebouncedRefresh, and without an override that lands on
// the repo's own .claude/scripts/.qmd-refresh-sentinel — shared with
// qmd-refresh.integration.test.ts, which already isolates itself and names
// this file as the reason it has to.
//
// The sentinel is created *pre-dated to now* rather than left absent,
// because "null sentinel → not debounced" is the documented rule: an empty
// tmp dir would make every one of these spawns fire a real detached QMD
// refresh at the working tree, which is both a side effect these tests
// don't want and enough load to time out unrelated suites. A fresh mtime
// puts each run inside the debounce window, so the trigger is exercised and
// then correctly declines to spawn.
let TMP_DIR = "";
let SENTINEL = "";
let stateCounter = 0;
let handoffCounter = 0;

before(() => {
	TMP_DIR = mkdtempSync(join(tmpdir(), "stop-checklist-"));
	SENTINEL = join(TMP_DIR, ".qmd-refresh-sentinel");
	writeFileSync(SENTINEL, "");
});

after(() => {
	rmTemp(TMP_DIR);
});

/** A fresh, isolated dedupe-state path, so no test sees another's history. */
function freshState(): string {
	stateCounter += 1;
	return join(TMP_DIR, `checklist-state-${stateCounter}.json`);
}

/**
 * Run the hook with an isolated sentinel and dedupe state. Pass the same
 * `state` path to several calls to simulate one machine across turns.
 */
function run(
	stdin: string | object | null,
	opts: {
		readonly state?: string;
		readonly vault?: string;
		readonly handoffDir?: string;
		readonly keep?: boolean;
		readonly env?: Readonly<Record<string, string>>;
	} = {},
) {
	handoffCounter += 1;
	const handoffDir = opts.handoffDir ?? join(TMP_DIR, `handoff-${handoffCounter}`);
	const result = spawnHook(SCRIPT, stdin, {
		QMD_REFRESH_SENTINEL: SENTINEL,
		STOP_CHECKLIST_STATE: opts.state ?? freshState(),
		STOP_HANDOFF_DIR: handoffDir,
		...(opts.vault ? { CLAUDE_PROJECT_DIR: opts.vault } : {}),
		...opts.env,
	});
	// What the agent receives: the report Stop saved for the next prompt.
	const sid = typeof stdin === "object" && stdin !== null ? (stdin as { session_id?: unknown }).session_id : undefined;
	const handed = typeof sid === "string" && sid && opts.keep !== true ? takeHandoff(handoffDir, sid) : null;
	return { ...result, handed };
}

/** The full report of a run: the handed-over report after its preface, or the systemMessage where nothing was handed over. */
function reportOf(r: { readonly stdout: string; readonly handed: string | null }): string {
	if (r.handed === null) return shownOf(r.stdout);
	assert.ok(r.handed.startsWith(`${AGENT_PREFACE}\n\n`), `handed report lacks the preface: ${r.handed.slice(0, 80)}`);
	return r.handed.slice(AGENT_PREFACE.length + 2);
}

/** Parse stdout as the hook envelope, failing loudly if it isn't JSON. */
function envelopeOf(stdout: string): Record<string, unknown> {
	try {
		return JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		return assert.fail(
			`stop-checklist must write a JSON envelope to stdout — got:\n  ${stdout}`,
		);
	}
}

/** What the user sees: the systemMessage, failing loudly if absent. */
function shownOf(stdout: string): string {
	const envelope = envelopeOf(stdout);
	const message = envelope["systemMessage"];
	assert.equal(
		typeof message,
		"string",
		`expected a string systemMessage — got: ${stdout}`,
	);
	return message as string;
}

/** A vault with these completed notes left in work/active/ (none = clean). */
function vault(name: string, ...completedNotes: string[]): string {
	const root = join(TMP_DIR, name);
	mkdirSync(join(root, "work/active"), { recursive: true });
	for (const note of completedNotes) completeNote(root, note);
	return root;
}

/** Leave `note` in work/active/ marked completed — one hygiene finding. */
function completeNote(root: string, note: string): void {
	writeFileSync(join(root, "work/active", note), "---\nstatus: completed\n---\n# Done\n");
}

// JSON.stringify drops an undefined session_id, so stop() is a Stop with none.
const stop = (session_id?: string) => ({ session_id, hook_event_name: "Stop", stop_hook_active: false });

describe("stop-checklist", () => {
	test("re-entry on strict boolean true emits the empty envelope", () => {
		const { stdout, code } = run({ stop_hook_active: true });
		assert.equal(code, 0);
		// `{}` rather than zero bytes: stdout is JSON-or-nothing here and
		// "nothing" is only documented by omission. The object carries no
		// field, so nothing renders on any agent.
		assert.deepEqual(envelopeOf(stdout), {});
	});

	test("re-entry writes its envelope before exiting", () => {
		// Regression guard for a platform-specific truncation: stdout is a
		// pipe, pipe writes are async on Windows, and this path writes and
		// then immediately calls process.exit(). A non-sync write here
		// arrives empty on Windows and passes everywhere else.
		const { stdout } = run({ stop_hook_active: true });
		assert.equal(stdout, "{}");
	});

	test("the first Stop of a session reports the checklist and findings", () => {
		const root = vault("first-stop", "Done.md");
		const message = reportOf(run(stop("s-first"), { vault: root }));
		assert.match(message, /Wrap-up checklist:/);
		assert.match(message, /work\/active\/Done\.md/);
	});

	test("a later Stop with an unchanged report is silent (#252)", () => {
		const root = vault("unchanged", "Done.md");
		const state = freshState();
		const first = run(stop("s-same"), { vault: root, state });
		const second = run(stop("s-same"), { vault: root, state });
		const third = run(stop("s-same"), { vault: root, state });
		assert.match(reportOf(first), /work\/active\/Done\.md/);
		assert.deepEqual(envelopeOf(second.stdout), {});
		assert.deepEqual(envelopeOf(third.stdout), {});
	});

	test("a Stop whose findings changed reports again", () => {
		const root = vault("changed", "Done.md");
		const state = freshState();
		run(stop("s-change"), { vault: root, state });
		completeNote(root, "Also Done.md");
		const message = reportOf(run(stop("s-change"), { vault: root, state }));
		assert.match(message, /work\/active\/Also Done\.md/);
	});

	test("a report that returns to an earlier one is shown again (A → B → A)", () => {
		// Drift fixed, then reintroduced: the last report shown was the clean
		// one, so the returning finding is a change and must reach the user.
		const root = vault("revert", "Done.md");
		const state = freshState();
		const a1 = run(stop("s-revert"), { vault: root, state });
		rmSync(join(root, "work/active/Done.md"));
		const b = run(stop("s-revert"), { vault: root, state });
		completeNote(root, "Done.md");
		const a2 = run(stop("s-revert"), { vault: root, state });
		assert.match(reportOf(a1), /work\/active\/Done\.md/);
		assert.doesNotMatch(reportOf(b), /Vault Hygiene/);
		assert.match(reportOf(a2), /work\/active\/Done\.md/);
	});

	test("a note growing past the threshold does not re-show the report", () => {
		// The message carries "(31KB)"-style sizes and day ages; those move
		// with no new drift, so they are left out of the comparison. A note
		// the agent keeps appending to must not bring back the per-turn repeat.
		const root = vault("growing");
		mkdirSync(join(root, "notes"), { recursive: true });
		const log = join(root, "notes/Log.md");
		writeFileSync(log, "x".repeat(26_000));
		const state = freshState();
		const first = run(stop("s-grow"), { vault: root, state });
		writeFileSync(log, "x".repeat(40_000));
		const second = run(stop("s-grow"), { vault: root, state });
		assert.match(reportOf(first), /notes\/Log\.md \(26KB\)/);
		assert.deepEqual(envelopeOf(second.stdout), {});
	});

	test("two oversized notes trading places by size does not re-show the report", () => {
		// The scan lists oversized notes largest first. Growing the smaller one
		// past the larger reorders the list; the findings are the same notes.
		const root = vault("two-growing");
		mkdirSync(join(root, "notes"), { recursive: true });
		writeFileSync(join(root, "notes/A.md"), "x".repeat(30_000));
		writeFileSync(join(root, "notes/B.md"), "x".repeat(26_000));
		const state = freshState();
		const first = run(stop("s-two-grow"), { vault: root, state });
		writeFileSync(join(root, "notes/B.md"), "x".repeat(34_000));
		const second = run(stop("s-two-grow"), { vault: root, state });
		assert.match(reportOf(first), /notes\/A\.md \(30KB\)[\s\S]*notes\/B\.md \(26KB\)/);
		assert.deepEqual(envelopeOf(second.stdout), {});
	});

	test("a changed Stop shows the user a summary and saves the full report for the next prompt (#256)", () => {
		// Every Stop output that reaches the model is printed in full for the
		// user: a block reason as a "Stop hook error", Stop additionalContext as
		// "Stop hook feedback". So Stop shows a summary, and the next prompt's
		// UserPromptSubmit, which the user never sees, hands the report over.
		const root = vault("block", "Done.md");
		const result = run(stop("s-block"), { vault: root });
		const envelope = envelopeOf(result.stdout);
		assert.deepEqual(Object.keys(envelope), ["systemMessage"], "no decision, no additionalContext: both are printed in full");
		const summary = String(envelope["systemMessage"]);
		assert.match(summary, /^Wrap-up checklist: archive completed work/);
		assert.match(summary, /^Hygiene: 1 note\(s\) marked done but still in active\/$/m);
		assert.doesNotMatch(summary, /work\/active\/Done\.md/, "the user sees the summary, not the listing");
		assert.match(summary, /The full report reaches the agent with your next message\.$/);
		assert.match(result.handed ?? "", /^Stop hook report, handed over with this message: .*ask the user when something needs their call/);
		assert.match(result.handed ?? "", /work\/active\/Done\.md/);
	});

	test("a report that cannot be saved goes out as Stop feedback, framed for a turn with no user message", () => {
		// A regular file where the directory should be: mkdir fails, so the
		// next prompt would have nothing to hand over.
		const root = vault("block-unsaved", "Done.md");
		const blocked = join(TMP_DIR, "handoff-is-a-file");
		writeFileSync(blocked, "");
		const result = run(stop("s-unsaved"), { vault: root, handoffDir: blocked });
		const envelope = envelopeOf(result.stdout);
		// Both readers are told what is true here: the report went to the agent
		// now, in a turn with no user message, and the user sees it in full.
		const summary = String(envelope["systemMessage"]);
		assert.match(summary, /^Hygiene: 1 note\(s\) marked done/m);
		assert.ok(summary.endsWith(FEEDBACK_TRAILER), summary);
		assert.ok(!summary.includes(SUMMARY_TRAILER), "it does not wait for the next message");
		const output = envelope["hookSpecificOutput"] as Record<string, unknown>;
		assert.equal(output["hookEventName"], "Stop");
		const context = String(output["additionalContext"]);
		assert.ok(context.startsWith(FEEDBACK_PREFACE), context.slice(0, 120));
		assert.doesNotMatch(context, /handed over with this message/);
		assert.match(context, /work\/active\/Done\.md/);
	});

	test("a saved report prunes the week-old ones a session never collected", () => {
		const root = vault("block-prune", "Done.md");
		const dir = join(TMP_DIR, "handoff-prune");
		mkdirSync(dir, { recursive: true });
		const stale = join(dir, "abandoned.txt");
		writeFileSync(stale, "an old report");
		const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(stale, eightDaysAgo, eightDaysAgo);
		run(stop("s-prune"), { vault: root, handoffDir: dir });
		assert.equal(existsSync(stale), false);
	});

	test("an unchanged Stop saves nothing for the next prompt", () => {
		const root = vault("block-quiet-2", "Done.md");
		const state = freshState();
		run(stop("s-quiet-2"), { vault: root, state });
		const second = run(stop("s-quiet-2"), { vault: root, state });
		assert.deepEqual(envelopeOf(second.stdout), {});
		assert.equal(second.handed, null);
	});

	test("a re-entered Stop is silent and saves nothing", () => {
		// Fresh state, so the change check would report: only the
		// stop_hook_active exit keeps a forced turn's Stop silent.
		const root = vault("block-reentry", "Done.md");
		const reentry = run({ session_id: "s-block-reentry", hook_event_name: "Stop", stop_hook_active: true }, { vault: root });
		assert.deepEqual(envelopeOf(reentry.stdout), {});
		assert.equal(reentry.handed, null);
	});

	test("a long hygiene list is capped, so the report stays under the hook output cap (#254)", () => {
		// Four hundred long names made a report several times the cap before
		// hygiene lists were capped; the headline keeps the full count.
		const names = Array.from({ length: 400 }, (_, i) => `A completed note with a deliberately long descriptive title ${i}.md`);
		const root = vault("block-huge", ...names);
		// The report is saved whole and cut only where it is delivered, beside the
		// routing hints, so measure it there: a prompt that raises every hint at once.
		const dir = join(TMP_DIR, "handoff-huge");
		const stopRun = run(stop("s-block-huge"), { vault: root, handoffDir: dir, keep: true });
		assert.ok(stopRun.stdout.length <= HOOK_OUTPUT_MAX_CHARS, `Stop stdout is ${stopRun.stdout.length} chars`);
		const prompt =
			"We decided on the new architecture after the outage incident. In my 1:1 with my manager we agreed we shipped it, a big win, and the project milestone is done.";
		const delivered = spawnHook(CLASSIFY, { session_id: "s-block-huge", hook_event_name: "UserPromptSubmit", prompt }, {
			STOP_HANDOFF_DIR: dir,
			CLASSIFY_HINT_STATE: join(TMP_DIR, "hints-huge.json"),
		});
		assert.ok(delivered.stdout.length <= HOOK_OUTPUT_MAX_CHARS, `UserPromptSubmit stdout is ${delivered.stdout.length} chars`);
		const context = String((envelopeOf(delivered.stdout)["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"]);
		assert.ok((context.match(/^- /gm) ?? []).length >= 5, "the prompt raised most of the routing hints");
		assert.match(context, /⚠️ {2}400 note\(s\) marked done but still in active\//);
		assert.match(context, /^ {3}- … and 390 more$/m);
		assert.doesNotMatch(context, /truncated to fit/);
	});

	test("SessionEnd and a Stop without a session_id show the full report and save nothing", () => {
		// Neither has a next prompt in this session for the report to ride.
		const root = vault("block-never", "Done.md");
		for (const payload of [stop(), { session_id: "s-end", hook_event_name: "SessionEnd" }]) {
			const result = run(payload, { vault: root });
			const envelope = envelopeOf(result.stdout);
			assert.deepEqual(Object.keys(envelope), ["systemMessage"]);
			assert.match(String(envelope["systemMessage"]), /work\/active\/Done\.md/);
			assert.equal(result.handed, null);
		}
	});

	test("a new session reports again even when nothing changed", () => {
		const root = vault("new-session", "Done.md");
		const state = freshState();
		run(stop("s-one"), { vault: root, state });
		const other = run(stop("s-two"), { vault: root, state });
		assert.match(reportOf(other), /work\/active\/Done\.md/);
	});

	test("a clean vault still gets the checklist once, then silence", () => {
		const root = vault("clean-vault");
		const state = freshState();
		const first = run(stop("s-clean"), { vault: root, state });
		const second = run(stop("s-clean"), { vault: root, state });
		assert.match(reportOf(first), /Wrap-up checklist:/);
		assert.doesNotMatch(reportOf(first), /Vault Hygiene/);
		assert.deepEqual(envelopeOf(second.stdout), {});
	});

	test("a Stop without a session_id fails open and reports every time", () => {
		// Same rule as the classifier's hint dedupe (#107): no key to
		// remember by means today's behaviour, never silence.
		const state = freshState();
		const first = run(stop(), { state });
		const second = run(stop(), { state });
		assert.match(reportOf(first), /Wrap-up checklist:/);
		assert.match(reportOf(second), /Wrap-up checklist:/);
	});

	test("an unreadable dedupe state fails open", () => {
		const state = freshState();
		writeFileSync(state, "not json{{");
		const { stdout } = run(stop("s-corrupt"), { state });
		assert.match(shownOf(stdout), /Wrap-up checklist:/);
	});

	test("string stop_hook_active is not re-entry", () => {
		const { stdout } = run({ ...stop("s-string"), stop_hook_active: "true" });
		assert.match(shownOf(stdout), /Wrap-up checklist:/);
	});

	test("SessionEnd reports every time — it is the last chance, not a turn", () => {
		const root = vault("session-end", "Done.md");
		const state = freshState();
		const payload = { session_id: "s-end", hook_event_name: "SessionEnd" };
		const first = run(payload, { vault: root, state });
		const second = run(payload, { vault: root, state });
		assert.match(reportOf(first), /work\/active\/Done\.md/);
		assert.match(reportOf(second), /work\/active\/Done\.md/);
	});

	test("SessionEnd after a deduped Stop still reports", () => {
		const root = vault("stop-then-end", "Done.md");
		const state = freshState();
		run(stop("s-mixed"), { vault: root, state });
		const end = run({ session_id: "s-mixed", hook_event_name: "SessionEnd" }, { vault: root, state });
		assert.match(reportOf(end), /work\/active\/Done\.md/);
	});

	test("the checklist hands drift to om-tidy", () => {
		const message = reportOf(run(stop("s-handoff")));
		assert.match(message, /ask the agent to run om-tidy/i);
	});

	test("malformed input emits a valid default", () => {
		const { stdout, code } = run("garbage{{");
		assert.equal(code, 0);
		assert.match(shownOf(stdout), /Wrap-up checklist:/);
	});

	test("empty stdin emits a valid default", () => {
		const { stdout, code } = run(null);
		assert.equal(code, 0);
		assert.match(shownOf(stdout), /Wrap-up checklist:/);
	});

	test("does not terminate the message with a stray newline", () => {
		// systemMessage is rendered by the agent's UI, not written to a
		// stream — a trailing newline is padding in all three.
		const message = reportOf(run({}));
		assert.equal(message, message.trimEnd());
	});

	// One script serves three agents whose payloads differ in shape: Claude
	// Code and Codex call it on Stop, Gemini on SessionEnd. Payloads mirror
	// each vendor's documented schema. Each runs against fresh state, so the
	// first report of each is the one compared.
	const AGENT_PAYLOADS: ReadonlyArray<{
		readonly label: string;
		readonly payload: Record<string, unknown>;
	}> = [
		{
			label: "Claude Code Stop",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				permission_mode: "default",
				hook_event_name: "Stop",
				last_assistant_message: "done",
				stop_hook_active: false,
			},
		},
		{
			label: "Codex Stop",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				hook_event_name: "Stop",
				model: "gpt-5.6-sol",
				permission_mode: "default",
				stop_hook_active: false,
			},
		},
		{
			label: "Gemini SessionEnd",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				hook_event_name: "SessionEnd",
				timestamp: "2026-08-03T12:00:00Z",
				reason: "exit",
			},
		},
	];

	// A Stop shows the user a summary and hands the full report over with the
	// next prompt; SessionEnd (Gemini) shows the full report. The full report
	// itself must not vary by agent.
	const rendered = new Set<string>();
	for (const { label, payload } of AGENT_PAYLOADS) {
		test(`${label} receives the same full report`, () => {
			const result = run(payload);
			assert.equal(result.code, 0);
			const message = reportOf(result);
			assert.match(message, /Wrap-up checklist:/);
			rendered.add(message);
		});
	}

	test("the full report does not vary by calling agent", () => {
		assert.equal(
			rendered.size,
			1,
			`every agent must get the same full report — got ${rendered.size} variants`,
		);
	});
});

/**
 * Under the template's Claude Code mod (#264, lib/om-mod.ts) the mod presents
 * the Stop report. `standdown` on the Stop it passes down must leave no trace;
 * `report` is the mod's own run and returns the report as data, claiming no
 * state and handing nothing over, because the mod owns both.
 */
describe("stop-checklist — om_mod (a Claude Code mod)", () => {
	const flagged = (session_id: string, om_mod: string) => ({ ...stop(session_id), om_mod });
	// The shared sentinel is fresh, so every refresh this file triggers is
	// debounced: nothing is spawned, and with HOOK_DEBUG=1 the call still
	// shows on stderr. That makes "was the refresh triggered?" observable.
	const DEBUG = { HOOK_DEBUG: "1" };
	const refreshed = (stderr: string) => stderr.includes("stop-checklist: debounced");
	// Re-touch the shared sentinel before each test: it was written once in
	// before(), and on a slow runner the tests above can outlast the 30s
	// debounce window, which would turn "debounced" into a real spawn.
	beforeEach(() => writeFileSync(SENTINEL, ""));

	test("standdown writes the empty envelope and touches no state, no handoff, no refresh", () => {
		const root = vault("ommod-standdown", "Done.md");
		const state = freshState();
		const dir = join(TMP_DIR, "handoff-ommod-standdown");
		const result = run(flagged("s-standdown", "standdown"), { vault: root, state, handoffDir: dir, keep: true, env: DEBUG });
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "{}");
		assert.equal(existsSync(state), false, "no dedupe state claimed");
		assert.equal(existsSync(dir), false, "no report saved for the next prompt");
		assert.equal(refreshed(result.stderr), false, "the mod's report run does the refresh");
	});

	test("the same Stop without the flag does claim state, hand the report over and refresh (the checks above can fail)", () => {
		const root = vault("ommod-plain", "Done.md");
		const state = freshState();
		const result = run(stop("s-plain"), { vault: root, state, env: DEBUG });
		assert.equal(existsSync(state), true);
		assert.ok(result.handed?.includes("work/active/Done.md"));
		assert.equal(refreshed(result.stderr), true);
	});

	test("report returns the report as data, refreshes, and claims no state and hands nothing over", () => {
		const root = vault("ommod-report", "Done.md");
		const state = freshState();
		const dir = join(TMP_DIR, "handoff-ommod-report");
		const result = run(flagged("s-report", "report"), { vault: root, state, handoffDir: dir, keep: true, env: DEBUG });
		assert.equal(result.code, 0);
		const { report } = envelopeOf(result.stdout) as { report: { key: string; claims: string[]; agentText: string } };
		assert.deepEqual(Object.keys(report).sort(), ["agentText", "claims", "key"], "data only: the mod draws its own line");
		assert.match(report.key, /^[0-9a-f]{16,}$/);
		assert.ok(report.claims.length > 0, "the drift is a claim");
		assert.ok(report.agentText.startsWith(`${MOD_PREFACE}\n\n`), "the mod's report carries the mod's framing, not the settings hook's");
		assert.match(report.agentText, /work\/active\/Done\.md/);
		assert.equal(existsSync(state), false, "the mod decides when the report changed");
		assert.equal(existsSync(dir), false, "the mod hands the report over");
		assert.equal(refreshed(result.stderr), true, "the mod's run replaces the hook's, refresh included");
	});

	test("report answers even on a re-entry event: the mod decides when to ask", () => {
		const root = vault("ommod-reentry", "Done.md");
		const result = run({ ...flagged("s-reentry", "report"), stop_hook_active: true }, { vault: root });
		const envelope = envelopeOf(result.stdout) as { report?: { agentText: string } };
		assert.ok(envelope.report, `expected a report, got ${result.stdout}`);
		assert.match(envelope.report.agentText, /work\/active\/Done\.md/);
	});

	test("report's key is the report's identity: stable for the same findings, different when they change", () => {
		const root = vault("ommod-key", "Done.md");
		const keyOf = () => (envelopeOf(run(flagged("s-key", "report"), { vault: root }).stdout) as { report: { key: string } }).report.key;
		const first = keyOf();
		assert.equal(keyOf(), first);
		completeNote(root, "Also Done.md");
		assert.notEqual(keyOf(), first);
	});

	test("an unknown om_mod value changes nothing: output identical to a Stop with no flag", () => {
		const root = vault("ommod-unknown", "Done.md");
		const plain = run(stop("s-unknown"), { vault: root });
		const unknown = run(flagged("s-unknown", "silence"), { vault: root });
		assert.equal(unknown.stdout, plain.stdout);
		assert.equal(unknown.handed, plain.handed);
		assert.ok(plain.handed?.includes("work/active/Done.md"));
	});
});
