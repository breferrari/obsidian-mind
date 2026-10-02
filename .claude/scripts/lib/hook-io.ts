/**
 * Shared I/O for hook entry points.
 *
 * The hook protocol expects exit 0 on failure with no output. readStdinJson
 * returns null on any error (malformed JSON, non-UTF8, empty stdin) so callers
 * can `if (!input) process.exit(0)` uniformly.
 *
 * Set HOOK_DEBUG=1 in the environment to emit diagnostic stderr lines from
 * any call site that uses debug(). Useful when a hook is silently failing
 * and you need to see which path it took.
 */

import { writeSync } from "node:fs";

export function debug(msg: string): void {
	if (process.env["HOOK_DEBUG"] === "1") {
		process.stderr.write(`[hook-debug ${new Date().toISOString()}] ${msg}\n`);
	}
}

/**
 * Emit a user-facing warning to stderr with the standard `⚠` prefix. Use for
 * non-fatal conditions the user should see (missing config, unexpected input
 * shape, etc.) so warning formatting stays consistent across scripts.
 */
export function warn(msg: string): void {
	process.stderr.write(`  ⚠ ${msg}\n`);
}

export async function readStdinJson<T = unknown>(): Promise<T | null> {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		}
		if (chunks.length === 0) return null;
		const text = Buffer.concat(chunks).toString("utf-8");
		if (!text.trim()) return null;
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

/**
 * Machine-readable finding riding hookSpecificOutput next to the prose
 * (#117). Prose stays the primary surface (the model acts on it); this
 * block is additive so deterministic tooling — a future `--fix`, a
 * headless tidy — can consume the same decision without parsing text.
 * `policy_id` is the stable per-detector identifier and versions the
 * contract.
 */
export type PolicyResult = {
	readonly policy_id: string;
	readonly path: string;
	readonly classification: string;
	readonly suggested_target?: string;
	readonly action: "warn" | "flag" | "none";
};

export function writeHookOutput(
	hookEventName: string,
	additionalContext: string,
	policyResults?: readonly PolicyResult[],
): void {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput:
				policyResults && policyResults.length > 0
					? { hookEventName, additionalContext, policyResults }
					: { hookEventName, additionalContext },
		}),
	);
}

/**
 * Emit a message addressed to the *user* rather than to the model.
 *
 * `systemMessage` is the one output field all three agents implement with
 * the same meaning — "show this to the human" — which makes it the only
 * portable channel for a hook that has something to say at session end.
 * The alternative, `hookSpecificOutput.additionalContext`, is Claude-Code-
 * only and is documented as feedback that *continues the conversation* —
 * wrong semantics for a wrap-up reminder, and a re-entry risk on Stop.
 *
 * Session-end stdout is JSON-or-nothing on every agent we ship configs for:
 * Codex rejects plain text outright, Gemini's SessionEnd contract is
 * "must not print any plain text to stdout other than the final JSON",
 * and Claude Code routes non-exempt plain stdout to the debug log where
 * nobody reads it. So there is no text path worth keeping.
 *
 * To reach the model as well, a Stop hook uses `writeStopBlock` instead.
 */
export function writeSystemMessage(message: string): void {
	const overhead = JSON.stringify({ systemMessage: "" }).length - 2;
	process.stdout.write(JSON.stringify({ systemMessage: fitEncoded(message, HOOK_OUTPUT_MAX_CHARS - overhead) }));
}

/**
 * Claude Code turns hook output over 10,000 characters into a short preview
 * (verified 2026-10-02, #254), so a report past it would reach the agent as
 * its first couple of KB. Writers hold the whole stdout under this, with
 * margin, measured after JSON escaping.
 */
export const HOOK_OUTPUT_MAX_CHARS = 9_500;

const CUT_MARKER = "\n… (truncated to fit the hook output cap)";

/**
 * `text`, cut with a marker so that its JSON-encoded form is at most `max`
 * characters. Escaping (`\n`, `\\`, quotes) is counted, which a cut on the
 * raw length would miss. It never splits an emoji: JSON.stringify escapes a
 * lone surrogate to six characters, so a cut inside a pair always costs more
 * than keeping the whole pair, and the search keeps the longest prefix that
 * fits.
 */
export function fitEncoded(text: string, max: number): string {
	if (JSON.stringify(text).length <= max) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (JSON.stringify(text.slice(0, mid) + CUT_MARKER).length <= max) lo = mid;
		else hi = mid - 1;
	}
	return text.slice(0, lo) + CUT_MARKER;
}

/**
 * A Stop that hands `reason` to the agent now and gives it another turn
 * (#256). The user reads the same text: Claude Code prints a block's reason
 * in the transcript, so a systemMessage beside it only showed the report
 * twice, the second copy cut to a third of the cap.
 *
 * `decision: "block"` is the only Stop output that reaches the model; every
 * other field is for the user. It also gives the agent a turn nobody typed,
 * so stop-checklist uses it only when its findings change, and relies on
 * `stop_hook_active` to keep the forced turn's own Stop from blocking again.
 * Claude Code honours it on Stop, and labels it "Stop hook error occurred" in
 * its UI even on success; Codex documents the same field. Gemini runs the
 * checklist on SessionEnd and never gets it.
 */
export function writeStopBlock(reason: string): void {
	const overhead = JSON.stringify({ decision: "block", reason: "" }).length - 2;
	process.stdout.write(JSON.stringify({ decision: "block", reason: fitEncoded(reason, HOOK_OUTPUT_MAX_CHARS - overhead) }));
}

/**
 * The empty envelope — valid JSON carrying no fields — for a hook that has
 * nothing to say on a protocol that wants JSON.
 *
 * Zero bytes would probably be fine: there is nothing for a parser to
 * reject. But Codex documents Stop stdout as "JSON on stdout when it exits
 * 0, plain text is invalid" without saying which side of that line empty
 * falls on, and a hook that is *sometimes* silent and *sometimes* JSON is a
 * harder contract to state than one that always emits exactly one object.
 * `{}` is unambiguous everywhere and renders nothing on all three agents,
 * since every common output field defaults to the no-op value.
 *
 * writeSync rather than process.stdout.write: callers use this immediately
 * before exiting, and stdout here is a pipe — pipe writes are asynchronous
 * on Windows, so a write raced against process.exit() can be truncated or
 * dropped entirely. The throw guard keeps a closed stdout from turning a
 * silent no-op into a non-zero exit, which the agent would report as a hook
 * failure — the exact class of bug this envelope exists to avoid.
 */
export function writeSilentHookOutput(): void {
	try {
		writeSync(1, "{}");
	} catch {
		/* stdout gone — nothing to report it to */
	}
}
