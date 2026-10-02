/**
 * Stop → UserPromptSubmit handoff for the Stop report.
 *
 * Every Stop output that reaches the model is also printed in the user's
 * transcript: a `decision: "block"` reason in full under a "Stop hook error"
 * label, and Stop `additionalContext` in full under "Stop hook feedback"
 * (both seen in a real terminal session, Claude Code 2.1.287). UserPromptSubmit
 * `additionalContext` is the one channel the model reads and the user never
 * sees. So Stop shows the user a one-line-per-section summary and saves the
 * full report here, and the next UserPromptSubmit in the same session hands it
 * to the model once and removes it.
 *
 * One file per session, so two sessions never read each other's report (the
 * shared mailbox an earlier design used lost reports under concurrency). A
 * write lands through a temp file and a rename, so a reader never sees half a
 * report. A read claims the file by renaming it first, so two racing hooks
 * cannot both deliver it. The newest report replaces an unread older one,
 * because it describes the current state. A report that cannot be written
 * throws, so Stop can send it as feedback instead; one that cannot be read is
 * null. Neither breaks a hook.
 *
 * A report saved just before /clear or the end of a session is never
 * collected: the next prompt arrives under a new session id. Nothing is lost
 * with it. The dedupe is per session, so the new session's first Stop reports
 * the same findings again, and the prune removes the orphan after a week.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.ts";

/**
 * Where a Stop report waits for the next prompt: one place for the writer
 * (stop-checklist) and the reader (classify-message), so they cannot drift
 * apart. STOP_HANDOFF_DIR routes it to a tmp path for tests.
 */
export const HANDOFF_DIR =
	process.env["STOP_HANDOFF_DIR"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".stop-handoff");

/** Reports nobody picked up are removed after this long. */
export const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The session's handoff file. Session ids are reduced to a safe filename. */
export function handoffPath(dir: string, sessionId: string): string {
	return join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
}

/** Save `text` for the session's next prompt, replacing any unread report. Throws if it cannot. */
export function writeHandoff(dir: string, sessionId: string, text: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(handoffPath(dir, sessionId), text);
}

/** Take the session's report, once. Null when there is none or it cannot be claimed. */
export function takeHandoff(dir: string, sessionId: string): string | null {
	const target = handoffPath(dir, sessionId);
	const claimed = `${target}.${process.pid}.claimed`;
	try {
		renameSync(target, claimed);
	} catch {
		return null; // none waiting, or another hook claimed it first
	}
	try {
		return readFileSync(claimed, "utf8");
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(claimed);
		} catch {
			/* best effort */
		}
	}
}

/** Remove reports and leftovers older than `maxAgeMs`. Best effort. */
export function pruneHandoffs(dir: string, now: number, maxAgeMs: number = HANDOFF_MAX_AGE_MS): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = join(dir, name);
		try {
			if (now - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full);
		} catch {
			/* best effort */
		}
	}
}
