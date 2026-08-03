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
 */
export function writeSystemMessage(message: string): void {
	process.stdout.write(JSON.stringify({ systemMessage: message }));
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
