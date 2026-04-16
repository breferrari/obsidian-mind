#!/usr/bin/env node
/**
 * PreCompact hook — back up the session transcript before the agent
 * compacts its context so lost history can be rehydrated from disk if
 * needed. Keeps the most recent 30 backups; older ones are pruned.
 *
 * Backups land in `${CLAUDE_PROJECT_DIR}/thinking/session-logs/` named
 * `session_<trigger>_<YYYYMMDD_HHMMSS>.jsonl`.
 */

import {
	mkdirSync,
	copyFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { readStdinJson } from "./lib/hook-io.ts";

type HookInput = {
	readonly transcript_path?: unknown;
	readonly trigger?: unknown;
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

// Only run main when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
	const input = await readStdinJson<HookInput>();
	if (!input) process.exit(0);

	const transcriptPath =
		typeof input.transcript_path === "string" ? input.transcript_path : "";
	const trigger =
		typeof input.trigger === "string" ? input.trigger : "unknown";

	if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

	const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
	const backupDir = join(projectDir, "thinking/session-logs");
	mkdirSync(backupDir, { recursive: true });

	const dest = join(
		backupDir,
		`session_${trigger}_${formatTimestamp(new Date())}.jsonl`,
	);

	try {
		copyFileSync(transcriptPath, dest);
	} catch {
		// Copy failure is non-fatal — we exit 0 and move on.
		process.exit(0);
	}

	pruneBackups(backupDir, BACKUP_RETAIN);
	process.exit(0);
}
