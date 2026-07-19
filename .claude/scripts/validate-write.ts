#!/usr/bin/env node
/**
 * PostToolUse hook — validate vault notes after Write/Edit operations.
 *
 * Reads the hook JSON payload from stdin, inspects the tool_input.file_path,
 * skips files outside the vault-note scope (dotfiles, templates, root docs,
 * translated READMEs, thinking drafts), and emits a hookSpecificOutput with
 * vault hygiene warnings when frontmatter or wikilinks are missing.
 */

import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { debug, readStdinJson, writeHookOutput } from "./lib/hook-io.ts";
import {
	isBlockedMemoryPath,
	shouldSkipFile,
	validateFile,
} from "./lib/frontmatter.ts";

type HookInput = {
	readonly tool_input?: unknown;
	readonly hook_event_name?: unknown;
};

const input = await readStdinJson<HookInput>();
if (!input) {
	debug("validate: null input");
	process.exit(0);
}

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== "object") {
	debug("validate: missing tool_input");
	process.exit(0);
}

const filePath = (toolInput as Record<string, unknown>).file_path;
if (typeof filePath !== "string" || !filePath) {
	debug("validate: missing file_path");
	process.exit(0);
}

// Memory-location guard (#81) runs BEFORE the vault-root skip: the
// auto-memory directory lives in ~/.claude/, outside the vault, and would
// otherwise be skipped. Only MEMORY.md (the auto-loaded index) belongs
// there — durable knowledge goes to brain/ topic notes per CLAUDE.md.
// PostToolUse can't block the write, but a loud warning makes the
// violation immediately visible so the file gets migrated before the
// index drifts. The predicate checks the lexically-normalized path AND
// the realpath-resolved one (the file exists by PostToolUse time), so
// neither `..` spellings nor symlinks dodge it.
let resolvedPath = filePath;
try {
	resolvedPath = realpathSync(filePath);
} catch {
	/* unreadable/racing path — lexical check below still applies */
}
if (isBlockedMemoryPath(filePath) || isBlockedMemoryPath(resolvedPath)) {
	const file = basename(filePath.replaceAll("\\", "/"));
	debug(`validate: misplaced memory file detected — ${file}`);
	const memoryContext = [
		`⚠️  Memory location violation: \`${file}\` was written to \`~/.claude/.../memory/\`.`,
		"",
		"Per CLAUDE.md, this directory should contain only MEMORY.md (the auto-loaded index).",
		"All durable knowledge belongs in the vault under `brain/` topic notes:",
		"",
		"- Patterns/conventions → `brain/Patterns.md`",
		"- Things that bit before → `brain/Gotchas.md`",
		"- Architectural/workflow decisions → `brain/Key Decisions.md`",
		"- Recent context, relationships, tools → `brain/Memories.md`",
		"- New topic → new `brain/<Topic>.md` note + index in `brain/Memories.md`",
		"",
		`Migrate the content from \`${file}\` into the right brain note, then delete the file from \`~/.claude/\`.`,
		"`MEMORY.md` itself can keep an index pointer to the brain note(s).",
	].join("\n");
	const memoryEventName =
		typeof input.hook_event_name === "string"
			? input.hook_event_name
			: "PostToolUse";
	writeHookOutput(memoryEventName, memoryContext, [
		{
			policy_id: "memory-location",
			path: filePath,
			classification: "misplaced-memory",
			suggested_target: "brain/",
			action: "warn",
		},
	]);
	process.exit(0);
}

// Vault-root skip AFTER the memory guard (which must inspect outside-vault
// paths): files outside the vault are not vault notes — no validation.
// Boundary-safe: "/vault" must not match "/vaulting/…", and an empty env
// value falls back to cwd (|| not ??).
const vaultRoot = (process.env["CLAUDE_PROJECT_DIR"] || process.cwd())
	.replaceAll("\\", "/")
	.replace(/\/+$/, "");
const filePathFwd = filePath.replaceAll("\\", "/");
if (filePathFwd !== vaultRoot && !filePathFwd.startsWith(vaultRoot + "/")) {
	debug(`validate: skipped (outside vault root) ${filePath}`);
	process.exit(0);
}

if (shouldSkipFile(filePath)) {
	debug(`validate: skipped ${filePath}`);
	process.exit(0);
}

const warnings = validateFile(filePath);
if (warnings === null) {
	debug(`validate: could not read ${filePath}`);
	process.exit(0);
}
debug(`validate: ${filePath} — ${warnings.length} warning(s)`);

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
