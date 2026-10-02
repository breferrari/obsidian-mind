#!/usr/bin/env node
/**
 * UserPromptSubmit hook — classify user messages and inject routing hints.
 *
 * Reads the hook JSON payload from stdin, inspects the `prompt` field for
 * signal patterns (see lib/signals.ts), and emits a hookSpecificOutput
 * envelope on stdout with one hint per matched signal. Exits 0 silently on
 * malformed input, missing prompt, or zero matches.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, readStdinJson, writeHookOutput } from "./lib/hook-io.ts";
import { classify } from "./lib/matcher.ts";
import { claimUnseen } from "./lib/hint-state.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// CLASSIFY_HINT_STATE routes the state file into a tmp path for tests
// (mirrors the QMD_REFRESH_SENTINEL pattern). Production never sets it.
const STATE_PATH =
	process.env["CLASSIFY_HINT_STATE"] ?? join(SCRIPT_DIR, ".hint-state.json");

type HookInput = {
	readonly prompt?: unknown;
	readonly hook_event_name?: unknown;
	readonly session_id?: unknown;
};

const input = await readStdinJson<HookInput>();
if (!input) {
	debug("classify: null input (bad/empty stdin)");
	process.exit(0);
}

const prompt = input.prompt;
if (typeof prompt !== "string" || !prompt) {
	debug(`classify: no usable prompt (type=${typeof prompt})`);
	process.exit(0);
}

const signals = classify(prompt);
debug(`classify: matched ${signals.length} signal(s)`);

// Once-per-session dedupe (#107): each hint fires once per session_id via
// a self-pruning state file (7-day age + 200-session cap). Missing/invalid
// session_id fails OPEN — every hint emits, matching today's behavior.
let toEmit = signals;
const sessionId = input.session_id;
if (typeof sessionId === "string" && sessionId && signals.length > 0) {
	toEmit = claimUnseen(STATE_PATH, sessionId, signals);
	debug(
		`classify: ${signals.length - toEmit.length} signal(s) already fired this session`,
	);
}

if (toEmit.length > 0) {
	const hints = toEmit.map((s) => `- ${s}`).join("\n");
	const additionalContext =
		"Content classification hints (act on these if the user's message contains relevant info):\n" +
		hints +
		"\n\nRemember: use proper templates, add [[wikilinks]], follow CLAUDE.md conventions.";

	const eventName =
		typeof input.hook_event_name === "string"
			? input.hook_event_name
			: "UserPromptSubmit";

	writeHookOutput(eventName, additionalContext);
}

process.exit(0);
