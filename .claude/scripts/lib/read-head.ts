/**
 * Read the first `chars` characters of a file without reading the rest of it.
 *
 * Four call sites inspect only a note's frontmatter — is it private, what is its
 * description, what are its aliases, was it agent-written — and every one of
 * them read the WHOLE file and discarded everything past the first kilobyte.
 * `visibleFiles` does that for every note it enumerates, and it is enumerated on
 * every search, every expand and every write, so the cost scaled with the total
 * BYTES in the vault rather than with the number of notes. One long reference
 * note made every unrelated call slower.
 *
 * Semantics are preserved exactly. `chars` counts characters, as `slice` counted
 * them; UTF-8 needs at most four bytes per character, so reading `chars * 4`
 * bytes and slicing the decoded prefix yields the identical string while
 * touching a bounded amount of the file. A character split across the end of the
 * buffer decodes to a replacement character, which the slice then discards —
 * it can only ever land beyond the `chars` boundary.
 *
 * Returns null when the file cannot be read, so each caller keeps its own
 * fallback: a note that cannot be inspected is not served, has no description,
 * and contributes no aliases.
 */

import { openSync, readSync, closeSync } from "node:fs";

/**
 * How much of a note's head is enough to hold its frontmatter.
 *
 * Named in CHARACTERS because that is what callers reason about and what the
 * `.slice()` this replaced counted — the buffer underneath is four times this,
 * since a UTF-8 character can take four bytes.
 */
export const HEAD_CHARS = 1200;

export function readHead(path: string, chars: number = HEAD_CHARS): string | null {
	if (!Number.isFinite(chars) || chars <= 0) return "";
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const want = chars * 4;
		// Unsafe is exact here: only `subarray(0, filled)` is ever decoded, and
		// every one of those bytes was written by `readSync` below. Zero-filling
		// would memset several kilobytes per note, on a path walked per call.
		const buf = Buffer.allocUnsafe(want);
		// `readSync` may return a short read even when more is available, so fill
		// the buffer rather than trusting one call to reach EOF or capacity.
		let filled = 0;
		while (filled < want) {
			const n = readSync(fd, buf, filled, want - filled, filled);
			if (n <= 0) break;
			filled += n;
		}
		return buf.subarray(0, filled).toString("utf8").slice(0, chars);
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* the read already succeeded or failed; a close error changes nothing */
			}
		}
	}
}
