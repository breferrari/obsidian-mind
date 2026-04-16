/**
 * Shared hook I/O: read JSON from stdin, write the hookSpecificOutput envelope
 * to stdout. Errors are swallowed — the hook protocol expects exit 0 and a
 * silent no-op on malformed input.
 *
 * Output format matches the Python reference implementation byte-for-byte:
 * - Key/value separator `": "` and item separator `", "` (Python json.dump default)
 * - Non-ASCII characters escaped as \uXXXX (Python ensure_ascii=True default)
 * This preserves parity with any agent consumer that hardcoded format expectations.
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

/**
 * Serialize a string as JSON with Python's ensure_ascii=True behavior:
 * non-ASCII code units (>= 0x80) are emitted as \uXXXX escapes. Surrogate
 * pairs for chars above the BMP come through naturally because JS strings
 * are UTF-16 and the regex iterates per code unit.
 */
function jsonStringPyCompat(s: string): string {
	return JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => {
		return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

export function writeHookOutput(
	hookEventName: string,
	additionalContext: string,
): void {
	const ev = jsonStringPyCompat(hookEventName);
	const ctx = jsonStringPyCompat(additionalContext);
	process.stdout.write(
		`{"hookSpecificOutput": {"hookEventName": ${ev}, "additionalContext": ${ctx}}}`,
	);
}
