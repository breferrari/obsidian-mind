/**
 * Claiming a filename without losing a write.
 *
 * Extracted because both write paths — memories and work records — need it, and
 * a correctness-critical pattern implemented twice is a fix applied once.
 *
 * WHY NOT check-then-write
 *
 * The obvious version is `while (existsSync(x)) bump(x); writeFileSync(x)`. It
 * is a TOCTOU race, and not a theoretical one: the deployment shape is one
 * server process PER CONSUMING REPO, all writing into one vault. Six processes
 * recording the same title produced FOUR files and SIX success messages — two
 * writes lost silently, reported as recorded, which is the worst outcome
 * available to a layer whose whole job is not losing them.
 *
 * `COPYFILE_EXCL` fails instead of clobbering, so the loser simply takes the
 * next suffix. The temp file also means a crash mid-write cannot leave a
 * half-written note for the indexer to pick up.
 */

import { writeFileSync, copyFileSync, unlinkSync, constants } from "node:fs";
import { join } from "node:path";

/** Per-process counter, so two in-flight writes cannot share a temp name. */
let tmpSeq = 0;

export interface ClaimResult {
	/** The filename that was successfully claimed. */
	readonly name: string;
	/** Its absolute path. */
	readonly full: string;
}

export interface ClaimOptions {
	/** How many suffixed names to try before giving up. */
	readonly maxAttempts?: number;
	/**
	 * Called with each candidate before it is claimed. Throw to refuse it —
	 * used by the capture path to verify containment rather than trust that a
	 * slug stripped every separator.
	 */
	readonly verify?: (full: string) => void;
	/** Message when every attempt collided. */
	readonly exhaustedMessage?: string;
}

/**
 * Write `body` into `dir` under the first free name `nameFor` produces.
 *
 * `nameFor(1)` is the preferred name; higher `n` are the collision fallbacks,
 * so the caller decides whether that looks like `note (2).md` or `note-2.md`.
 */
export function claimFile(
	dir: string,
	body: string,
	nameFor: (n: number) => string,
	{ maxAttempts = 50, verify, exhaustedMessage = "too many colliding files for that name" }: ClaimOptions = {},
): ClaimResult {
	const tmp = join(dir, `.om-${process.pid}-${++tmpSeq}.tmp`);
	writeFileSync(tmp, body, "utf8");
	try {
		for (let n = 1; n <= maxAttempts; n++) {
			const name = nameFor(n);
			const full = join(dir, name);
			verify?.(full);
			try {
				copyFileSync(tmp, full, constants.COPYFILE_EXCL);
				return { name, full };
			} catch (e) {
				if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
			}
		}
		throw new Error(exhaustedMessage);
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* temp cleanup is best-effort */
		}
	}
}
