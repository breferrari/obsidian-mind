/**
 * The files a write hook's payload says were written (#354).
 *
 * Claude Code and Gemini name one `tool_input.file_path`. Codex's
 * apply_patch names none: its hook input is `tool_input: { command: <the raw
 * patch> }` (openai/codex core/src/tools/handlers/apply_patch.rs, as of
 * 2026-10-13), and the files are the patch's own headers. Relative headers
 * resolve against the payload's `cwd`, which Codex sends as an absolute path
 * (hooks/src/events/post_tool_use.rs).
 */

import { resolve } from "node:path";

// openai/codex apply-patch/src/parser.rs: a hunk header starts its own line.
const ADD_FILE = "*** Add File: ";
const UPDATE_FILE = "*** Update File: ";
const DELETE_FILE = "*** Delete File: ";
const MOVE_TO = "*** Move to: ";

/** The path after `marker` on a header line, or null when the line is not that header or names nothing. */
function matchHeader(line: string, marker: string): string | null {
	if (!line.startsWith(marker)) return null;
	const path = line.slice(marker.length).trim();
	return path === "" ? null : path;
}

/**
 * What a patch leaves on disk to validate (`written`: added and updated files,
 * a moved file at its new path) and what it takes away (`removed`: deleted
 * files, a moved file's old path), in patch order.
 */
function patchPaths(patch: string): { written: string[]; removed: string[] } {
	const written: string[] = [];
	const removed: string[] = [];
	let afterUpdate = false;
	for (const raw of patch.split(/\r?\n/)) {
		// Hunk bodies start with "+", "-", " " or "@@", so a header line is never
		// content; a body line that happens to read like one is prefixed.
		const line = raw.trimEnd();
		const wasUpdate = afterUpdate;
		afterUpdate = false;
		const added = matchHeader(line, ADD_FILE);
		const updated = added === null ? matchHeader(line, UPDATE_FILE) : null;
		const deleted = matchHeader(line, DELETE_FILE);
		const movedTo = wasUpdate ? matchHeader(line, MOVE_TO) : null;
		if (added !== null) written.push(added);
		else if (updated !== null) {
			written.push(updated);
			afterUpdate = true;
		} else if (deleted !== null) removed.push(deleted);
		else if (movedTo !== null) {
			// The file now lives at the new path and the old one is gone: the new
			// path is validated, and both count for the index.
			removed.push(written[written.length - 1] as string);
			written[written.length - 1] = movedTo;
		}
	}
	return { written, removed };
}

/** The payload's paths, absolute and normalised, once each; null when it names none. */
function payloadPaths(input: unknown, projectDir: string): { written: string[]; removed: string[] } | null {
	if (!input || typeof input !== "object") return null;
	const payload = input as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
	const toolInput = payload.tool_input;
	if (!toolInput || typeof toolInput !== "object") return null;
	const fields = toolInput as { file_path?: unknown; command?: unknown };

	if (typeof fields.file_path === "string" && fields.file_path !== "") return { written: [fields.file_path], removed: [] };
	if (payload.tool_name !== "apply_patch" || typeof fields.command !== "string") return null;

	// resolve() keeps an absolute path absolute and normalises it, so one file
	// spelled two ways is still one target.
	const base = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : projectDir;
	const absolute = (paths: string[]) => [...new Set(paths.map((p) => resolve(base, p)))];
	const { written, removed } = patchPaths(fields.command);
	return { written: absolute(written), removed: absolute(removed) };
}

/**
 * Every file the payload left to validate, absolute and once each. A
 * `file_path` is returned as given, exactly as validate-write read it before
 * (#354). Empty when the payload names none.
 */
export function writeTargets(input: unknown, projectDir: string): string[] {
	return payloadPaths(input, projectDir)?.written ?? [];
}

/**
 * Every file whose change the search index should see: what was written and
 * what was removed (a deleted note, a moved note's old path), once each. The
 * index would otherwise keep serving a note that is gone.
 */
export function refreshTargets(input: unknown, projectDir: string): string[] {
	const paths = payloadPaths(input, projectDir);
	return paths === null ? [] : [...new Set([...paths.removed, ...paths.written])];
}
