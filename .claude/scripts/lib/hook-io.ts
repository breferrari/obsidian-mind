/**
 * Shared I/O for hook entry points.
 *
 * The hook protocol expects exit 0 on failure with no output. readStdinJson
 * returns null on any error (malformed JSON, non-UTF8, empty stdin) so callers
 * can `if (!input) process.exit(0)` uniformly.
 */

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
