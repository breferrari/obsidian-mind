#!/usr/bin/env node
/**
 * Conversation-boundary hook — the wrap-up checklist plus concrete
 * vault-hygiene findings, and a debounced QMD refresh so the next session
 * opens against a current index.
 *
 * Where it runs is decided by where its message can be seen (#252):
 *
 *  - Claude Code and Codex call it on Stop, which fires after EVERY
 *    response, not at the end of the session. An unconditional report there
 *    repeats unchanged drift on every turn, and a warning that never changes
 *    is one users learn to ignore (#155). So on Stop the report is shown
 *    once per session and again only when its text changes; otherwise the
 *    hook emits the empty envelope and only refreshes QMD.
 *  - Gemini calls it on SessionEnd, whose systemMessage it displays during
 *    shutdown. That is a last chance rather than a turn, so it always reports.
 *
 * Claude Code and Codex are deliberately NOT wired to SessionEnd: Claude Code
 * discards a SessionEnd hook's systemMessage, and Codex documents SessionEnd
 * as advisory and does not surface its systemMessage. Moving the report
 * there would turn "every turn" into "never".
 *
 * Who reads it: a Stop hook's systemMessage reaches the user and never the
 * agent, so the drift the agent is best placed to fix never reached it
 * (#256). On a Stop whose findings changed, the user gets a
 * one-line-per-section summary as the `systemMessage`, and the full report is
 * saved for the session's next prompt, where classify-message hands it to the
 * agent (why that channel: lib/stop-handoff.ts). If the report cannot be
 * saved, it goes out as Stop feedback instead: visible, but not lost (Claude
 * Code; Codex's handling of Stop feedback is unverified, lib/hook-io.ts).
 * SessionEnd and a Stop without a session_id have no next prompt to ride: the
 * user gets the full report.
 *
 * Output is JSON on every agent, never plain text. Codex rejects plain Stop
 * stdout, Gemini's SessionEnd contract requires a final JSON object, and
 * Claude Code otherwise files non-exempt stdout in the debug log.
 * `systemMessage` is the one user-facing field all three agents share. Both it
 * and the handed-over report are held under Claude Code's hook output cap
 * (lib/hook-io.ts).
 * The documented event name is the only branch — no agent sniffing and no
 * agent-specific argument.
 *
 * Under the template's Claude Code mod (#264, lib/om-mod.ts) the mod presents
 * the report itself: it runs this script with `om_mod: "report"` to get the
 * report as data, and flags the Stop it passes down with
 * `om_mod: "standdown"`, on which this hook writes the empty envelope and
 * does nothing else. Without the mod, nothing sends the flag.
 */

import { readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readStdinJson,
	writeSilentHookOutput,
	writeStopFeedback,
	writeSystemMessage,
} from "./lib/hook-io.ts";
import { readOmMod } from "./lib/om-mod.ts";
import { triggerDebouncedRefresh } from "./lib/qmd-refresh.ts";
import { HANDOFF_DIR, pruneHandoffs, writeHandoff } from "./lib/stop-handoff.ts";
import { AGENT_PREFACE, FEEDBACK_PREFACE, FEEDBACK_TRAILER, stopSummary } from "./lib/stop-report.ts";
import {
	formatActiveHygiene,
	hygieneClaims,
	parseMemoryRoot,
	parseOpenLoopConfig,
	scanActiveHygiene,
} from "./lib/active-hygiene.ts";
import { parseInfraRootFilenames } from "./lib/session-start.ts";
import { claimChanged } from "./lib/hint-state.ts";
import { reportKey } from "./lib/report-key.ts";
import { resolveProjectDir } from "./lib/project-dir.ts";

const DEBOUNCE_MS = 30_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// See qmd-refresh.ts for the rationale behind the env override — it
// keeps parallel test workers from racing on the shared repo sentinel.
const SENTINEL_PATH =
	process.env["QMD_REFRESH_SENTINEL"] ??
	join(SCRIPT_DIR, ".qmd-refresh-sentinel");
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");
// The last report each session was shown (lib/hint-state.ts, the same
// self-pruning, fail-open store as the classifier's hint dedupe, #107).
// STOP_CHECKLIST_STATE routes it to a tmp path for tests.
const STATE_PATH =
	process.env["STOP_CHECKLIST_STATE"] ??
	join(SCRIPT_DIR, ".checklist-state.json");

type HookInput = {
	readonly hook_event_name?: unknown;
	readonly session_id?: unknown;
	readonly stop_hook_active?: unknown;
};

const input = await readStdinJson<HookInput>();
// The mod presents this Stop (lib/om-mod.ts): the empty envelope, no state,
// no handoff, no refresh. The mod's own `report` run does the refresh.
const omMod = readOmMod(input);
if (omMod === "standdown") {
	writeSilentHookOutput();
	process.exit(0);
}
// Re-entry (the Stop after a turn some Stop hook forced, or a secondary
// agent's): say nothing, which keeps a forced turn from looping, spawn no second refresh,
// but still emit the empty envelope rather than zero bytes — see
// writeSilentHookOutput for why "sometimes silent, sometimes JSON" is the
// weaker contract.
if (input?.stop_hook_active === true) {
	writeSilentHookOutput();
	process.exit(0);
}

// Each item as the full report says it and as the user's summary says it.
const CHECKLIST_ITEMS: readonly (readonly [full: string, short: string])[] = [
	["Archive completed projects? (work/active/ -> work/archive/YYYY/)", "archive completed work"],
	["Update indexes? (Index.md, Memories.md, People & Context, Brag Doc)", "update indexes"],
	["New notes linked? (orphans are bugs)", "link new notes"],
	["Ask the agent to run om-vault-audit if many notes were created/modified", "om-vault-audit if many notes changed"],
	["To act on any drift, ask the agent to run om-tidy", "ask the agent to run om-tidy for drift"],
];
const checklist = ["Wrap-up checklist:", ...CHECKLIST_ITEMS.map(([full]) => `- ${full}`)].join("\n");
const CHECKLIST_SUMMARY = `Wrap-up checklist: ${CHECKLIST_ITEMS.map(([, short]) => short).join(" · ")}`;

// Concrete drift findings beat a generic checklist (#98/#103/#106): the
// same scan SessionStart runs, so the session closes against the same
// facts it opened with. Silent when clean.
const vaultRoot = resolveProjectDir(process.cwd());
let manifestJson: string | null = null;
try {
	manifestJson = readFileSync(join(vaultRoot, "vault-manifest.json"), {
		encoding: "utf-8",
	});
} catch {
	/* missing manifest → default open-loop config */
}
const report = scanActiveHygiene(
	vaultRoot,
	Date.now(),
	parseOpenLoopConfig(manifestJson),
	parseInfraRootFilenames(manifestJson),
	parseMemoryRoot(manifestJson),
);
const hygieneLines = formatActiveHygiene(report);

// No trailing newline: this is a message rendered by the agent's UI, not a
// line written to a stream.
const message =
	checklist +
	(hygieneLines.length > 0
		? "\n\nVault Hygiene (drift detected):\n" + hygieneLines.join("\n")
		: "");

// Numbers that move with no new drift to act on: a note growing past the
// threshold, an item a day older. They stay in the message but not in the
// report's identity, and neither does the order they sort findings into
// (lib/report-key.ts), or a note the agent keeps appending to would re-show
// the report every turn — the #252 repeat by another route.
const VOLATILE_FIELDS = new Set(["sizeKb", "ageDays", "oldestDays"]);

// SessionEnd (and any input without a recognisable event, the safe default)
// always reports. Stop reports when the findings differ from the last report
// this session was shown: the first Stop, and any change since, including
// drift that was fixed and then came back. A missing session_id fails open
// to reporting.
const sessionId = input?.session_id;
const isStop = input?.hook_event_name === "Stop";
const hasSession = typeof sessionId === "string" && sessionId !== "";
const show =
	omMod !== "report" &&
	(!isStop || !hasSession || claimChanged(STATE_PATH, sessionId, reportKey({ checklist, report }, VOLATILE_FIELDS)));

if (omMod === "report") {
	// The mod's own run (lib/om-mod.ts): the report as data. The mod shows the
	// summary, hands the agent the report and decides when it changed, so no
	// state is claimed and nothing is handed over here. `key` is the report's
	// identity, the same one the Stop dedupe above compares.
	const claims = hygieneClaims(report);
	writeSync(
		1,
		JSON.stringify({
			report: {
				key: reportKey({ checklist, report }, VOLATILE_FIELDS),
				summary: stopSummary(CHECKLIST_SUMMARY, claims),
				claims,
				agentText: `${AGENT_PREFACE}\n\n${message}`,
			},
		}),
	);
} else if (!show) writeSilentHookOutput();
else if (isStop && hasSession) {
	// The summary now, the full report with the next prompt; Stop feedback if it cannot be saved.
	const claims = hygieneClaims(report);
	try {
		pruneHandoffs(HANDOFF_DIR, Date.now());
		writeHandoff(HANDOFF_DIR, sessionId, `${AGENT_PREFACE}\n\n${message}`);
		writeSystemMessage(stopSummary(CHECKLIST_SUMMARY, claims));
	} catch {
		writeStopFeedback(`${FEEDBACK_PREFACE}\n\n${message}`, stopSummary(CHECKLIST_SUMMARY, claims, FEEDBACK_TRAILER));
	}
}
else writeSystemMessage(message);

triggerDebouncedRefresh({
	sentinelPath: SENTINEL_PATH,
	workerPath: WORKER_PATH,
	debounceMs: DEBOUNCE_MS,
	logPrefix: "stop-checklist",
});
