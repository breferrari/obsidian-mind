/**
 * PostToolUse hook — validate vault notes after Write/Edit operations.
 *
 * Reads the hook JSON payload from stdin, inspects the tool_input.file_path,
 * skips files outside the vault-note scope (dotfiles, templates, root docs,
 * translated READMEs, thinking drafts), and emits a hookSpecificOutput with
 * vault hygiene warnings when frontmatter or wikilinks are missing.
 */

import { basename } from "node:path";
import { readStdinJson, writeHookOutput } from "./lib/hook-io.ts";
import { shouldSkipFile, validateFile } from "./lib/frontmatter.ts";

type HookInput = {
	readonly tool_input?: unknown;
	readonly hook_event_name?: unknown;
};

const input = await readStdinJson<HookInput>();
if (!input) process.exit(0);

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== "object") process.exit(0);

const filePath = (toolInput as { file_path?: unknown }).file_path;
if (typeof filePath !== "string" || !filePath) process.exit(0);

if (shouldSkipFile(filePath)) process.exit(0);

const warnings = validateFile(filePath);
if (warnings === null) process.exit(0);

if (warnings.length > 0) {
	const hintList = warnings.map((w) => `  - ${w}`).join("\n");
	const base = basename(filePath.replaceAll("\\", "/"));
	const additionalContext = `Vault hygiene warnings for \`${base}\`:\n${hintList}\nFix these before moving on.`;

	const eventName =
		typeof input.hook_event_name === "string"
			? input.hook_event_name
			: "PostToolUse";

	writeHookOutput(eventName, additionalContext);
}

process.exit(0);
