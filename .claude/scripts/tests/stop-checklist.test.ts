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

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runScript as spawnHook, rmTemp } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../stop-checklist.ts",
);

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
	opts: { readonly state?: string; readonly vault?: string } = {},
) {
	return spawnHook(SCRIPT, stdin, {
		QMD_REFRESH_SENTINEL: SENTINEL,
		STOP_CHECKLIST_STATE: opts.state ?? freshState(),
		...(opts.vault ? { CLAUDE_PROJECT_DIR: opts.vault } : {}),
	});
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

/**
 * The report the user is shown, failing loudly if absent: a Stop block's
 * reason after the agent preface (Claude Code prints the reason in the
 * transcript), otherwise the systemMessage.
 */
function shownOf(stdout: string): string {
	const envelope = envelopeOf(stdout);
	if (envelope["decision"] === "block") {
		const reason = String(envelope["reason"]);
		return reason.slice(reason.indexOf("\n\n") + 2);
	}
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
		const message = shownOf(run(stop("s-first"), { vault: root }).stdout);
		assert.match(message, /Wrap-up checklist:/);
		assert.match(message, /work\/active\/Done\.md/);
	});

	test("a later Stop with an unchanged report is silent (#252)", () => {
		const root = vault("unchanged", "Done.md");
		const state = freshState();
		const first = run(stop("s-same"), { vault: root, state });
		const second = run(stop("s-same"), { vault: root, state });
		const third = run(stop("s-same"), { vault: root, state });
		assert.match(shownOf(first.stdout), /work\/active\/Done\.md/);
		assert.deepEqual(envelopeOf(second.stdout), {});
		assert.deepEqual(envelopeOf(third.stdout), {});
	});

	test("a Stop whose findings changed reports again", () => {
		const root = vault("changed", "Done.md");
		const state = freshState();
		run(stop("s-change"), { vault: root, state });
		completeNote(root, "Also Done.md");
		const message = shownOf(run(stop("s-change"), { vault: root, state }).stdout);
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
		assert.match(shownOf(a1.stdout), /work\/active\/Done\.md/);
		assert.doesNotMatch(shownOf(b.stdout), /Vault Hygiene/);
		assert.match(shownOf(a2.stdout), /work\/active\/Done\.md/);
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
		assert.match(shownOf(first.stdout), /notes\/Log\.md \(26KB\)/);
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
		assert.match(shownOf(first.stdout), /notes\/A\.md \(30KB\)[\s\S]*notes\/B\.md \(26KB\)/);
		assert.deepEqual(envelopeOf(second.stdout), {});
	});

	test("a changed Stop report reaches the agent: decision block with the report as the reason (#256)", () => {
		// A Stop systemMessage never reaches the model. decision "block" is the
		// one Stop output that does, with a turn to act, ask, or say nothing
		// needs doing. Claude Code prints the reason in the transcript, so the
		// user reads it there; a systemMessage beside it showed the report twice.
		const root = vault("block", "Done.md");
		const envelope = envelopeOf(run(stop("s-block"), { vault: root }).stdout);
		assert.deepEqual(Object.keys(envelope), ["decision", "reason"]);
		assert.equal(envelope["decision"], "block");
		const reason = String(envelope["reason"]);
		assert.match(reason, /^Stop hook report: .*ask the user when something needs their call/);
		assert.match(reason, /work\/active\/Done\.md/);
	});

	test("an unchanged Stop sends the agent nothing", () => {
		const root = vault("block-quiet", "Done.md");
		const state = freshState();
		run(stop("s-block-quiet"), { vault: root, state });
		assert.deepEqual(envelopeOf(run(stop("s-block-quiet"), { vault: root, state }).stdout), {});
	});

	test("the forced turn's own Stop does not block again", () => {
		// Fresh state, so the change check would block: only the
		// stop_hook_active exit keeps the forced turn's Stop silent.
		const root = vault("block-reentry", "Done.md");
		const reentry = run({ session_id: "s-block-reentry", hook_event_name: "Stop", stop_hook_active: true }, { vault: root });
		assert.deepEqual(envelopeOf(reentry.stdout), {});
	});

	test("a report too big for the hook output cap still fits, cut with a marker", () => {
		// Completed notes left in work/active/ are listed uncapped; four hundred
		// long names make a report several times the cap.
		const names = Array.from({ length: 400 }, (_, i) => `A completed note with a deliberately long descriptive title ${i}.md`);
		const root = vault("block-huge", ...names);
		const { stdout } = run(stop("s-block-huge"), { vault: root });
		assert.ok(stdout.length <= 9_500, `stdout is ${stdout.length} chars`);
		const envelope = envelopeOf(stdout);
		assert.equal(envelope["decision"], "block");
		assert.match(String(envelope["reason"]), /truncated to fit the hook output cap\)$/);
	});

	test("SessionEnd and a Stop without a session_id never block", () => {
		// SessionEnd has no turn to give, and without a session_id nothing
		// stops a block from repeating every turn.
		const root = vault("block-never", "Done.md");
		for (const payload of [stop(), { session_id: "s-end", hook_event_name: "SessionEnd" }]) {
			const envelope = envelopeOf(run(payload, { vault: root }).stdout);
			assert.equal(envelope["decision"], undefined);
			assert.match(String(envelope["systemMessage"]), /work\/active\/Done\.md/);
		}
	});

	test("a new session reports again even when nothing changed", () => {
		const root = vault("new-session", "Done.md");
		const state = freshState();
		run(stop("s-one"), { vault: root, state });
		const other = run(stop("s-two"), { vault: root, state });
		assert.match(shownOf(other.stdout), /work\/active\/Done\.md/);
	});

	test("a clean vault still gets the checklist once, then silence", () => {
		const root = vault("clean-vault");
		const state = freshState();
		const first = run(stop("s-clean"), { vault: root, state });
		const second = run(stop("s-clean"), { vault: root, state });
		assert.match(shownOf(first.stdout), /Wrap-up checklist:/);
		assert.doesNotMatch(shownOf(first.stdout), /Vault Hygiene/);
		assert.deepEqual(envelopeOf(second.stdout), {});
	});

	test("a Stop without a session_id fails open and reports every time", () => {
		// Same rule as the classifier's hint dedupe (#107): no key to
		// remember by means today's behaviour, never silence.
		const state = freshState();
		const first = run(stop(), { state });
		const second = run(stop(), { state });
		assert.match(shownOf(first.stdout), /Wrap-up checklist:/);
		assert.match(shownOf(second.stdout), /Wrap-up checklist:/);
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
		assert.match(shownOf(first.stdout), /work\/active\/Done\.md/);
		assert.match(shownOf(second.stdout), /work\/active\/Done\.md/);
	});

	test("SessionEnd after a deduped Stop still reports", () => {
		const root = vault("stop-then-end", "Done.md");
		const state = freshState();
		run(stop("s-mixed"), { vault: root, state });
		const end = run({ session_id: "s-mixed", hook_event_name: "SessionEnd" }, { vault: root, state });
		assert.match(shownOf(end.stdout), /work\/active\/Done\.md/);
	});

	test("the checklist hands drift to om-tidy", () => {
		const message = shownOf(run(stop("s-handoff")).stdout);
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
		const message = shownOf(run({}).stdout);
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

	const rendered = new Set<string>();
	for (const { label, payload } of AGENT_PAYLOADS) {
		test(`${label} receives the same JSON envelope`, () => {
			const { stdout, code } = run(payload);
			assert.equal(code, 0);
			const message = shownOf(stdout);
			assert.match(message, /Wrap-up checklist:/);
			rendered.add(message);
		});
	}

	test("output does not vary by calling agent", () => {
		assert.equal(
			rendered.size,
			1,
			`every agent must get byte-identical output — got ${rendered.size} variants`,
		);
	});
});
