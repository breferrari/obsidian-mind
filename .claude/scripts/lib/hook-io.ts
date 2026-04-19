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

export function writeHookOutput(
	hookEventName: string,
	additionalContext: string,
): void {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName, additionalContext },
		}),
	);
}
