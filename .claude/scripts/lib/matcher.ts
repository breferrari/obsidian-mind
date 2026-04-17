/**
 * Regex boundary logic for classify-message.
 *
 * Uses Latin-letter lookarounds instead of \b. \b treats CJK characters as word
 * characters (\w), so \bdecision\b fails to match in "のdecisionについて"
 * (no boundary between Hiragana and Latin). The (?<![a-zA-Z]) and (?![a-zA-Z])
 * lookarounds enforce Latin word boundaries while allowing CJK adjacency.
 */

import { SIGNALS } from "./signals.ts";

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileMatcher(phrases: readonly string[]): RegExp {
	const body = phrases.map(escapeRegex).join("|");
	return new RegExp(`(?<![a-zA-Z])(?:${body})(?![a-zA-Z])`);
}

// Precomputed once per process. classify() runs on every UserPromptSubmit, so
// avoiding per-call regex construction matters — 7 signals × ~20 patterns is
// ~140 RegExp allocations saved per message.
const SIGNAL_MATCHERS: ReadonlyArray<{ message: string; regex: RegExp }> =
	SIGNALS.map((s) => ({
		message: s.message,
		regex: compileMatcher(s.patterns),
	}));

export function anyWordMatch(
	phrases: readonly string[],
	text: string,
): boolean {
	if (phrases.length === 0) return false;
	return compileMatcher(phrases).test(text);
}

export function classify(prompt: string): string[] {
	const lowered = prompt.toLowerCase();
	const messages: string[] = [];
	for (const { message, regex } of SIGNAL_MATCHERS) {
		if (regex.test(lowered)) messages.push(message);
	}
	return messages;
}
