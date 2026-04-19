#!/usr/bin/env node
/**
 * SessionStart hook — inject vault context into the agent's first turn.
 *
 * Emits a markdown block on stdout with: date header, North Star excerpt,
 * recent git changes (last 48h), open tasks (via Obsidian CLI if available),
 * active work listing, and a full vault markdown file listing.
 *
 * Also persists VAULT_PATH to CLAUDE_ENV_FILE when Claude Code provides it.
 */

import {
	readFileSync,
	appendFileSync,
	readdirSync,
	type Dirent,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	take,
	formatDateHeader,
	formatActiveWork,
	formatRecentChanges,
	isSkippedPath,
	extractFrontmatterField,
	formatBrainIndex,
	stripFrontmatter,
	hasBrainContent,
	parseQmdIndex,
	qmdArgsWithIndex,
} from "./lib/session-start.ts";

function readManifestRaw(): string | null {
	try {
		return readFileSync("vault-manifest.json", { encoding: "utf-8" });
	} catch {
		return null;
	}
}

const cwd =
	process.env["CLAUDE_PROJECT_DIR"] ??
	process.env["CODEX_PROJECT_DIR"] ??
	process.env["GEMINI_PROJECT_DIR"] ??
	process.cwd();
process.chdir(cwd);

// Persist vault path for any downstream shell consumers (Claude Code feature)
const envFile = process.env["CLAUDE_ENV_FILE"];
if (envFile) {
	try {
		appendFileSync(envFile, `export VAULT_PATH="${cwd}"\n`);
	} catch {
		/* best-effort — session continues even if persistence fails */
	}
}

// Incremental QMD re-index. Fire-and-forget; ignore failures (qmd is optional).
// Scope to this vault's named index when the manifest declares one, so vaults
// sharing a machine don't blend results in QMD's default global index. Falls
// back silently for forks that haven't adopted the `qmd_index` manifest field.
const qmdIndex = parseQmdIndex(readManifestRaw());
spawnSync("qmd", qmdArgsWithIndex(qmdIndex, ["update"]), {
	stdio: "ignore",
	timeout: 30_000,
});

type CmdResult =
	| { readonly kind: "ok"; readonly stdout: string }
	| { readonly kind: "missing" }
	| { readonly kind: "failed" };

function runCmd(
	cmd: string,
	args: readonly string[],
	timeoutMs = 5_000,
): CmdResult {
	const r = spawnSync(cmd, args as string[], {
		encoding: "utf-8",
		timeout: timeoutMs,
	});
	if (
		r.error &&
		(r.error as NodeJS.ErrnoException).code === "ENOENT"
	) {
		return { kind: "missing" };
	}
	if (r.status !== 0) return { kind: "failed" };
	return { kind: "ok", stdout: r.stdout ?? "" };
}


function northStar(): string {
	// Prefer Obsidian CLI when available (authoritative for wikilink resolution)
	const cli = runCmd("obsidian", ["read", "file=North Star"]);
	if (cli.kind === "ok") return take(cli.stdout, 30);
	try {
		return take(readFileSync("brain/North Star.md", { encoding: "utf-8" }), 30);
	} catch {
		return "(not found)";
	}
}

function recentChanges(): string {
	const r = runCmd("git", [
		"log",
		"--oneline",
		"--since=48 hours ago",
		"--no-merges",
	]);
	if (r.kind !== "ok") return "(no git history)";
	return formatRecentChanges(r.stdout, 15);
}

function openTasks(): string {
	const r = runCmd("obsidian", ["tasks", "daily", "todo"]);
	if (r.kind === "missing") return "(Obsidian CLI not available)";
	if (r.kind === "failed") return "(CLI timed out)";
	return take(r.stdout, 10);
}

function brainIndex(): string {
	let entries: Dirent[];
	try {
		entries = readdirSync("brain", { withFileTypes: true });
	} catch {
		return "(none)";
	}
	const files = entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name)
		.sort();
	const parsed = files.map((f) => {
		const name = f.replace(/\.md$/, "");
		let description: string | null = null;
		let hasContent = false;
		try {
			const content = readFileSync(join("brain", f), { encoding: "utf-8" });
			description = extractFrontmatterField(content, "description");
			hasContent = hasBrainContent(stripFrontmatter(content));
		} catch {
			/* unreadable file → show name with no description, treat as empty */
		}
		return { name, description, hasContent };
	});
	return formatBrainIndex(parsed);
}

function activeWork(): string {
	let entries: Dirent[];
	try {
		entries = readdirSync("work/active", { withFileTypes: true });
	} catch {
		return "(none)";
	}
	const files = entries.filter((e) => e.isFile()).map((e) => e.name);
	return formatActiveWork(files, 10);
}

const SKIP_PREFIXES: readonly string[] = [
	".git",
	".obsidian",
	"thinking",
	".claude",
];

function listMd(): string[] {
	const results: string[] = [];
	function walk(dir: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = dir === "." ? e.name : join(dir, e.name);
			if (isSkippedPath(full, SKIP_PREFIXES)) continue;
			if (e.isDirectory()) walk(full);
			else if (e.isFile() && e.name.endsWith(".md")) results.push(`./${full}`);
		}
	}
	walk(".");
	return results.sort();
}

const sections = [
	"## Session Context",
	"",
	"### Date",
	formatDateHeader(new Date()),
	"",
	"### North Star (current goals)",
	northStar(),
	"",
	"### Brain Topics (read on demand)",
	brainIndex(),
	"",
	"### Recent Changes (last 48h)",
	recentChanges(),
	"",
	"### Open Tasks",
	openTasks(),
	"",
	"### Active Work",
	activeWork(),
	"",
	"### Vault File Listing",
	listMd().join("\n"),
];

process.stdout.write(sections.join("\n") + "\n");
