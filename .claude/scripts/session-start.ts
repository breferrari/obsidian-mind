#!/usr/bin/env node
/**
 * SessionStart hook — inject vault context into the agent's first turn.
 *
 * Emits a markdown block on stdout with: date header, North Star excerpt,
 * brain-topics index, recent git changes (last 48h), open tasks aggregated
 * from work/active/ and the vault root, active work listing, and a full
 * vault markdown file listing.
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
	parseInfraRootFilenames,
	isInfraFilename,
	isMarkdownFilename,
	collectOpenTasks,
} from "./lib/session-start.ts";
import { buildQmdCommand, resolveQmdEntry } from "./lib/qmd.ts";

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

// Manifest is read once and reused: QMD's named index, the infrastructure
// allowlist for openTasks(), and any future manifest-driven sections all
// derive from the same source. Both helpers tolerate a null source so a
// missing/malformed manifest degrades quietly.
const manifestJson = readManifestRaw();
const infraRootFilenames = parseInfraRootFilenames(manifestJson);

// Incremental QMD re-index. Fire-and-forget; ignore failures (qmd is optional).
// Scope to this vault's named index when the manifest declares one, so vaults
// sharing a machine don't blend results in QMD's default global index. Falls
// back silently for forks that haven't adopted the `qmd_index` manifest field.
//
// Route through `buildQmdCommand` so the same shim-bypass logic that fixes
// the MCP wrapper applies here too — `node qmd.js update` runs identically
// on Windows, macOS, and Linux; no platform conditionals.
const qmdIndex = parseQmdIndex(manifestJson);
const qmdUpdate = buildQmdCommand(
	resolveQmdEntry(),
	qmdArgsWithIndex(qmdIndex, ["update"]),
);
spawnSync(qmdUpdate.cmd, qmdUpdate.args as string[], {
	stdio: "ignore",
	timeout: 30_000,
	shell: qmdUpdate.shell,
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
	// Filesystem-only: the path is fixed by template convention, so there's no
	// wikilink-resolution value worth a CLI hop — and `spawnSync("obsidian", …)`
	// launches the Electron app on macOS when no instance is running (#83).
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

function readMarkdownSource(
	path: string,
): { path: string; content: string } | null {
	try {
		return { path, content: readFileSync(path, { encoding: "utf-8" }) };
	} catch {
		return null;
	}
}

function listMarkdownSources(
	dir: string,
	pathFor: (name: string) => string,
	skip: (name: string) => boolean = () => false,
): { path: string; content: string }[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const sources: { path: string; content: string }[] = [];
	for (const e of entries) {
		if (!e.isFile() || !isMarkdownFilename(e.name) || skip(e.name)) continue;
		const src = readMarkdownSource(pathFor(e.name));
		if (src !== null) sources.push(src);
	}
	return sources;
}

function openTasks(): string {
	// Filesystem scan, not `obsidian tasks daily todo` (#83 — that CLI flashes
	// the Electron app on macOS). Order matters: project tasks in work/active/
	// surface first, then vault-root notes (which is where daily notes live by
	// Obsidian's default — empirically the dominant task store in user vaults).
	// Infra files (CLAUDE.md, README.*.md, …) are excluded so the section is
	// user content only. Paths use forward slashes so the output reads the same
	// in Claude's context on any OS.
	const sources = [
		...listMarkdownSources("work/active", (name) => `work/active/${name}`),
		...listMarkdownSources(
			".",
			(name) => name,
			(name) => isInfraFilename(name, infraRootFilenames),
		),
	];
	return collectOpenTasks(sources, 10);
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
