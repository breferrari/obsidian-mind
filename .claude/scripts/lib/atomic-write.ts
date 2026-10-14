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

import { writeFileSync, readFileSync, copyFileSync, renameSync, unlinkSync, constants } from "node:fs";
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

/**
 * Replace `path` with `text` through a temp file and a rename, so a reader
 * never sees half a file and a process killed mid-write leaves the previous
 * one. Unlike `claimFile`, it overwrites. Throws if it cannot, after removing
 * its temp file.
 */
export function writeFileAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}-${++tmpSeq}.tmp`;
	try {
		writeFileSync(tmp, text, "utf8");
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* nothing was written */
		}
		throw err;
	}
}

/** What a guarded rewrite ended up doing. */
export type RewriteResult = "written" | "unchanged" | "contended";

/**
 * Rewrite an existing file only if it is unchanged since `transform` read it.
 *
 * WHY NOT just read, edit, writeFileAtomic
 *
 * That is a read-modify-write with nothing between the read and the write that
 * notices the file changed. Two writers each read the original, each applies
 * its own edit, and the second rename erases the first — both reported as
 * written. markSuperseded lost 90 of 200 titles exactly this way (see its
 * module header). `writeFileAtomic` makes each replacement invisible to
 * readers; it does nothing about the lost-update between them.
 *
 * So: re-read just before replacing. If the file still holds what `transform`
 * read, the rename lands. If anything else wrote in between, throw the temp
 * away and re-apply the edit to the fresh content, a bounded number of times —
 * the same shape as `claimFile`'s collision loop, pointed at content instead
 * of names. `transform` returning null means there is nothing to change.
 *
 * The window is not zero — it shrinks from the whole edit to two filesystem
 * calls, and a writer that loses now retries instead of overwriting silently.
 * Closing it fully needs a lock file, which brings stale-lock handling with
 * it; not worth it for a frontmatter list.
 */
export function rewriteIfUnchanged(
	path: string,
	transform: (current: string) => string | null,
	attempts = 3,
): RewriteResult {
	for (let i = 0; i < attempts; i++) {
		const before = readFileSync(path, "utf8");
		const next = transform(before);
		if (next === null || next === before) return "unchanged";
		const tmp = `${path}.${process.pid}-${++tmpSeq}.tmp`;
		writeFileSync(tmp, next, "utf8");
		try {
			if (readFileSync(path, "utf8") !== before) continue; // changed under us: retry on fresh content
			renameSync(tmp, path);
			return "written";
		} finally {
			try {
				unlinkSync(tmp);
			} catch {
				/* already renamed, or nothing to clean up */
			}
		}
	}
	return "contended";
}
