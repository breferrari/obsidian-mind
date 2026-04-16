/**
 * Regex boundary logic + orchestration for classify-message.
 *
 * Uses Latin-letter lookarounds instead of \b. \b treats CJK
 * characters as word characters (\w), so \bdecision\b fails to match
 * in "のdecisionについて" (no boundary between Hiragana and Latin).
 *
 * (?<![a-zA-Z]) and (?![a-zA-Z]) ensure English keywords aren't part of
 * a larger English word, while allowing CJK adjacency.
 */

import { SIGNALS } from "./signals.ts";

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function anyWordMatch(
	phrases: readonly string[],
	text: string,
): boolean {
	for (const phrase of phrases) {
		const pattern = new RegExp(
			`(?<![a-zA-Z])${escapeRegex(phrase)}(?![a-zA-Z])`,
		);
		if (pattern.test(text)) return true;
	}
	return false;
}

/**
 * Classify a prompt string. Returns the list of signal messages that fired.
 * Mirrors the Python classify() function: lowercases the input once, then
 * iterates every signal in order.
 */
export function classify(prompt: string): string[] {
	const lowered = prompt.toLowerCase();
	const messages: string[] = [];
	for (const signal of SIGNALS) {
		if (anyWordMatch(signal.patterns, lowered)) {
			messages.push(signal.message);
		}
	}
	return messages;
}
