#!/usr/bin/env node
/**
 * PreCompact hook — back up the session transcript before the agent
 * compacts its context so lost history can be rehydrated from disk if
 * needed. Keeps the most recent 30 backups; older ones are pruned.
 *
 * Backups land in the vault root's `thinking/session-logs/` (the root found
 * by lib/project-dir.ts) named
 * `session_<trigger>_<YYYYMMDD_HHMMSS>.jsonl`.
 */

import {
	mkdirSync,
	copyFileSync,
	readdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, readStdinJson } from "./lib/hook-io.ts";
import { isMainModule } from "./lib/main-guard.ts";
import { sentinelPathFrom, triggerDebouncedRefresh } from "./lib/qmd-refresh.ts";
import { resolveProjectDir } from "./lib/project-dir.ts";
import { reinjectSession, storeReinject } from "./lib/reinject.ts";
import { sessionStartContext } from "./lib/session-start-run.ts";
import { HANDOFF_DIR } from "./lib/stop-handoff.ts";

type HookInput = {
	readonly transcript_path?: unknown;
	readonly trigger?: unknown;
	readonly hook_event_name?: unknown;
	readonly session_id?: unknown;
};

const BACKUP_RETAIN = 30;

export function formatTimestamp(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

export function listBackups(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.startsWith("session_") && f.endsWith(".jsonl"))
			.map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)
			.map((e) => e.name);
	} catch {
		return [];
	}
}

export function pruneBackups(dir: string, retain: number): void {
	const ordered = listBackups(dir);
	for (const name of ordered.slice(retain)) {
		try {
			unlinkSync(join(dir, name));
		} catch {
			/* best effort — retention is soft */
		}
	}
}

if (isMainModule(import.meta.url)) {
	const input = await readStdinJson<HookInput>();
	if (!input) process.exit(0);

	// Fire a debounced QMD refresh before (or alongside) the backup.
	// Writes tend to cluster right before compaction, and catching them
	// now means the session-resume SessionStart runs `qmd update` against
	// an index that's already current. Uses the same sentinel as the
	// PostToolUse and Stop hooks so we never spawn a redundant worker.
	{
		const scriptDir = dirname(fileURLToPath(import.meta.url));
		triggerDebouncedRefresh({
			sentinelPath: sentinelPathFrom(process.env, scriptDir),
			workerPath: resolvePath(scriptDir, "qmd-refresh-run.ts"),
			debounceMs: 30_000,
			logPrefix: "pre-compact",
		});
	}

	// The backup first: it is this hook's own job, and the re-injection below
	// can take most of Gemini's PreCompress budget. Best effort, so a backup
	// that throws never costs the re-injection.
	backupTranscript(input);

	// Gemini fires no SessionStart after compressing, so store the context for
	// the next BeforeAgent to re-inject (lib/reinject.ts, #357).
	const reinjectFor = reinjectSession(input);
	if (reinjectFor !== null) {
		const context = sessionStartContext();
		try {
			storeReinject(HANDOFF_DIR, reinjectFor, context);
		} catch (err) {
			debug(`pre-compact: could not store the re-injection: ${(err as Error).message}`);
		}
	}
	process.exit(0);
}

/** Copy the transcript into thinking/session-logs and prune old copies. Best effort. */
function backupTranscript(input: HookInput): void {
	const transcriptPath =
		typeof input.transcript_path === "string" ? input.transcript_path : "";
	const trigger =
		typeof input.trigger === "string" ? input.trigger : "unknown";

	if (!transcriptPath) {
		debug("pre-compact: no transcript_path in input");
		return;
	}

	const projectDir = resolveProjectDir(process.cwd());
	const backupDir = join(projectDir, "thinking/session-logs");
	mkdirSync(backupDir, { recursive: true });

	const dest = join(
		backupDir,
		`session_${trigger}_${formatTimestamp(new Date())}.jsonl`,
	);

	try {
		copyFileSync(transcriptPath, dest);
		debug(`pre-compact: backed up ${transcriptPath} → ${dest}`);
	} catch (err) {
		// Both "transcript missing" (ENOENT) and any other fs error are non-fatal:
		// hook protocol requires exit 0. The debug line differentiates so a
		// missing-transcript scenario isn't logged as a "copy failed" anomaly.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			debug(`pre-compact: transcript not found (path=${transcriptPath})`);
		} else {
			debug(`pre-compact: copy failed: ${(err as Error).message}`);
		}
		return;
	}

	pruneBackups(backupDir, BACKUP_RETAIN);
}
