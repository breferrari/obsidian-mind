#!/usr/bin/env node
/**
 * PostToolUse hook — validate vault notes after Write/Edit operations.
 *
 * Reads the hook JSON payload from stdin and inspects each file it wrote: the
 * tool_input.file_path (Claude Code, Gemini), or every file a Codex
 * apply_patch adds, updates or moves (lib/write-targets.ts, #354). It
 * skips files outside the vault-note scope (dotfiles, templates, root docs,
 * translated READMEs, thinking drafts), and emits a hookSpecificOutput with
 * vault hygiene warnings when frontmatter or wikilinks are missing.
 */

import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
	debug,
	readStdinJson,
	writeHookOutput,
	type PolicyResult,
} from "./lib/hook-io.ts";
import {
	countTicketIdWikilinks,
	isBlockedMemoryPath,
	parseFrontmatterRequired,
	shouldSkipFile,
	validateContent,
} from "./lib/frontmatter.ts";
import {
	MONOLITH_BYTES,
	formatClusterHint,
	formatMonolithHint,
	isMonolithExempt,
	newNoteClusterCandidate,
} from "./lib/active-hygiene.ts";
import {
	refreshesVaultIndex,
	sentinelPathFrom,
	triggerDebouncedRefresh,
} from "./lib/qmd-refresh.ts";
import { resolveProjectDir } from "./lib/project-dir.ts";
import { refreshTargets, writeTargets } from "./lib/write-targets.ts";

type HookInput = {
	readonly hook_event_name?: unknown;
};

const input = await readStdinJson<HookInput>();
if (!input) {
	debug("validate: null input");
	process.exit(0);
}

// Boundary-safe vault root: "/vault" must not match "/vaulting/…"; an empty
// env value falls back to cwd (lib/project-dir.ts).
const vaultRoot = resolveProjectDir(process.cwd())
	.replaceAll("\\", "/")
	.replace(/\/+$/, "");

// One file for Claude Code and Gemini (file_path); every file a Codex
// apply_patch adds, updates or moves, whose payload names none (#354). The
// index also sees what a patch deleted or moved away.
const targets = writeTargets(input, vaultRoot);
const refreshed = refreshTargets(input, vaultRoot);
if (refreshed.length === 0) {
	debug("validate: no file_path and no patch targets");
	process.exit(0);
}

// Debounced QMD refresh (#107) — fire-and-forget, never blocks validation.
// Folded here from the retired qmd-refresh.ts entry so every .md write
// costs ONE process spawn, not two (~150-300ms each on Windows). Runs
// before the skip ladder so template/root/memory paths still refresh.
const DEBOUNCE_MS = 30_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SENTINEL_PATH = sentinelPathFrom(process.env, SCRIPT_DIR);
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");
if (refreshed.some((path) => refreshesVaultIndex(path, vaultRoot))) {
	triggerDebouncedRefresh({
		sentinelPath: SENTINEL_PATH,
		workerPath: WORKER_PATH,
		debounceMs: DEBOUNCE_MS,
		logPrefix: "validate-write",
	});
}

// The required fields come from the manifest's frontmatter_required, the
// same declaration the docs point at; an unreadable manifest falls back to
// the three global fields. Read lazily, once per call: a write the skip
// ladder discards never pays for it, and a patch's files share it.
let manifest: unknown;
const loadManifest = (): unknown => {
	if (manifest !== undefined) return manifest;
	try {
		manifest = JSON.parse(readFileSync(join(vaultRoot, "vault-manifest.json"), "utf-8"));
	} catch {
		manifest = null;
	}
	return manifest;
};

/** What one written file adds to the call's single envelope. */
type FileFindings = { readonly blocks: string[]; readonly policyResults: PolicyResult[] };

function checkFile(filePath: string): FileFindings {
	const blocks: string[] = [];
	const policyResults: PolicyResult[] = [];

	// Memory-location guard (#81) runs BEFORE the vault-root skip: the
	// auto-memory directory lives in ~/.claude/, outside the vault, and would
	// otherwise be skipped. Only MEMORY.md (the auto-loaded index) belongs
	// there — durable knowledge goes to brain/ topic notes per .claude/rules/memory.md.
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
		blocks.push(
			[
				`⚠️  Memory location violation: \`${file}\` was written to \`~/.claude/.../memory/\`.`,
				"",
				"Per .claude/rules/memory.md, this directory should contain only MEMORY.md (the auto-loaded index).",
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
			].join("\n"),
		);
		policyResults.push({
			policy_id: "memory-location",
			path: filePath,
			classification: "misplaced-memory",
			suggested_target: "brain/",
			action: "warn",
		});
		return { blocks, policyResults };
	}

	// Vault-root skip AFTER the memory guard (which must inspect outside-vault
	// paths): files outside the vault are not vault notes — no validation.
	const filePathFwd = filePath.replaceAll("\\", "/");
	if (filePathFwd !== vaultRoot && !filePathFwd.startsWith(vaultRoot + "/")) {
		debug(`validate: skipped (outside vault root) ${filePath}`);
		return { blocks, policyResults };
	}

	if (shouldSkipFile(filePath)) {
		debug(`validate: skipped ${filePath}`);
		return { blocks, policyResults };
	}

	// Single read: prose warnings AND policy results derive from the same
	// content snapshot — no second read, no TOCTOU window between them.
	let content: string;
	try {
		content = readFileSync(filePath, { encoding: "utf-8" });
	} catch {
		debug(`validate: could not read ${filePath}`);
		return { blocks, policyResults };
	}
	const relPath = filePathFwd.startsWith(vaultRoot + "/")
		? filePathFwd.slice(vaultRoot.length + 1)
		: filePathFwd;
	const warnings = validateContent(content, {
		required: parseFrontmatterRequired(loadManifest()),
		relPath,
	});
	debug(`validate: ${filePath} — ${warnings.length} warning(s)`);

	if (warnings.length > 0) {
		const hintList = warnings.map((w) => `  - ${w}`).join("\n");
		const base = basename(filePathFwd);
		blocks.push(
			`Vault hygiene warnings for \`${base}\`:\n${hintList}\nFix these before moving on.`,
		);
		// Phantom-edge findings ride the #117 contract like every other
		// detector — counted from the SAME content snapshot the prose came from.
		if (countTicketIdWikilinks(content) > 0) {
			policyResults.push({
				policy_id: "phantom-edge",
				path: relPath,
				classification: "ticket-id-wikilink",
				action: "warn",
			});
		}
	}

	// Write-time organization flags (#103): the same detectors the scan hooks
	// run, moved to the moment of growth — the session that just made a note
	// oversized (or added the note that completes a cluster) has the context
	// to organize it NOW. Each detector is isolated so a future unguarded
	// edit inside one can't kill the sibling checks in the same write.
	try {
		const size = statSync(filePath).size;
		if (
			size >= MONOLITH_BYTES &&
			!isMonolithExempt(basename(filePathFwd))
		) {
			blocks.push(formatMonolithHint(relPath, size));
			policyResults.push({
				policy_id: "organization-threshold",
				path: relPath,
				classification: "oversized-note",
				action: "flag",
			});
		}
	} catch {
		debug("validate: monolith check failed — skipped");
	}
	try {
		const cluster = newNoteClusterCandidate(filePath, vaultRoot);
		if (cluster !== null) {
			blocks.push(formatClusterHint(cluster));
			policyResults.push({
				policy_id: "topic-cluster",
				path: relPath,
				classification: "ungrouped-cluster",
				suggested_target: "work/active/<Topic>/",
				action: "flag",
			});
		}
	} catch {
		debug("validate: cluster check failed — skipped");
	}

	return { blocks, policyResults };
}

// One envelope for the call, however many files it wrote: each file's
// findings in patch order, a file that throws costing only its own. A finding
// several files share (the cluster they all join) is said once. A single
// write reads exactly as before.
const findings = targets.map((t): FileFindings => {
	try {
		return checkFile(t);
	} catch (err) {
		debug(`validate: ${t} — check failed: ${(err as Error)?.message ?? err}`);
		return { blocks: [], policyResults: [] };
	}
});
const blocks = [...new Set(findings.flatMap((f) => f.blocks))];
if (blocks.length > 0) {
	const eventName =
		typeof input.hook_event_name === "string"
			? input.hook_event_name
			: "PostToolUse";
	const policies = new Map(findings.flatMap((f) => f.policyResults).map((p) => [JSON.stringify(p), p] as const));
	writeHookOutput(eventName, blocks.join("\n\n"), [...policies.values()]);
}

process.exit(0);
