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

import { isAbsolute, resolve } from "node:path";

// openai/codex apply-patch/src/parser.rs: a hunk header starts its own line.
// A deleted file is not a target: there is nothing left to validate.
const ADD_FILE = "*** Add File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";

/** The paths a patch adds, updates, or moves a file to, in patch order. */
function patchTargets(patch: string): string[] {
	const out: string[] = [];
	let afterUpdate = false;
	for (const raw of patch.split(/\r?\n/)) {
		// Hunk bodies start with "+", "-", " " or "@@", so a header line is never
		// content; a body line that happens to read like one is prefixed.
		const line = raw.trimEnd();
		if (line.startsWith(ADD_FILE)) {
			out.push(line.slice(ADD_FILE.length));
			afterUpdate = false;
		} else if (line.startsWith(UPDATE_FILE)) {
			out.push(line.slice(UPDATE_FILE.length));
			afterUpdate = true;
		} else if (afterUpdate && line.startsWith(MOVE_TO)) {
			// The file now lives at the new path: that is what gets validated.
			out[out.length - 1] = line.slice(MOVE_TO.length);
			afterUpdate = false;
		} else {
			afterUpdate = false;
		}
	}
	return out.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Every file the payload wrote, absolute and once each. Empty when the payload
 * names none, so the caller has nothing to validate.
 */
export function writeTargets(input: unknown, projectDir: string): string[] {
	if (!input || typeof input !== "object") return [];
	const payload = input as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
	const toolInput = payload.tool_input;
	if (!toolInput || typeof toolInput !== "object") return [];
	const fields = toolInput as { file_path?: unknown; command?: unknown };

	if (typeof fields.file_path === "string" && fields.file_path !== "") return [fields.file_path];
	if (payload.tool_name !== "apply_patch" || typeof fields.command !== "string") return [];

	const base = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : projectDir;
	const seen = new Set<string>();
	for (const p of patchTargets(fields.command)) seen.add(isAbsolute(p) ? p : resolve(base, p));
	return [...seen];
}
