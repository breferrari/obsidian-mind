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
	statSync,
	type Dirent,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	take,
	formatDateHeader,
	quoteForPosixShell,
	injectionMode,
	formatInjectionSize,
	formatActiveWork,
	formatRecentChanges,
	isSkippedPath,
	extractFrontmatterField,
	formatBrainIndex,
	stripFrontmatter,
	hasBrainContent,
	parseQmdIndex,
	parseQmdMinVersion,
	qmdArgsWithIndex,
	isQmdNativeAbiMismatch,
	qmdPackageRootFromEntry,
	resolveIndexStorePath,
	parseInfraRootFilenames,
	isInfraFilename,
	isMarkdownFilename,
	collectOpenTasks,
} from "./lib/session-start.ts";
import {
	buildQmdCommand,
	qmdVersionAtLeast,
	resolveQmdEntry,
} from "./lib/qmd.ts";
import {
	formatActiveHygiene,
	parseOpenLoopConfig,
	scanActiveHygiene,
} from "./lib/active-hygiene.ts";

import { readStdinJson } from "./lib/hook-io.ts";

type HookInput = { readonly source?: unknown };

// The SessionStart payload carries `source` (startup/clear/resume/compact).
// Missing or unparseable stdin fails open to full mode. stdin is OPTIONAL
// for this hook (unlike the payload-driven ones), so guard the read: a
// TTY (manual run) skips it entirely, and a pipe that never delivers EOF
// is abandoned after a short deadline — the injection must never hang on
// a harness that doesn't send the payload.
async function readHookInput(): Promise<HookInput | null> {
	if (process.stdin.isTTY) return null;
	let timer: NodeJS.Timeout | undefined;
	const result = await Promise.race([
		readStdinJson<HookInput>(),
		new Promise<null>((resolveRace) => {
			timer = setTimeout(() => resolveRace(null), 2_000);
			timer.unref();
		}),
	]);
	if (timer !== undefined) clearTimeout(timer);
	if (result === null) {
		// Abandoned or empty read: drop the stream so a still-open pipe
		// can't keep the process alive after the injection is written.
		process.stdin.destroy();
	}
	return result;
}
const hookInput = await readHookInput();
const mode = injectionMode(hookInput?.source);

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
		appendFileSync(envFile, `export VAULT_PATH=${quoteForPosixShell(cwd)}\n`);
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

// Incremental QMD re-index. Truly fire-and-forget: detached, unref'd,
// ignore-all-streams. The hook's own work (file walks, git log, context
// emission) is independent of this index update, so blocking on qmd's
// startup (notably slow on Windows × Node 24 cold start, where it can
// approach 10s before the actual update work begins) is wasted user
// latency. Scope to this vault's named index when the manifest declares
// one; fall back silently for forks that haven't adopted `qmd_index`.
// Route through `buildQmdCommand` so the shim-bypass logic that fixes
// the MCP wrapper applies here too.
const qmdIndex = parseQmdIndex(manifestJson);
const qmdEntry = resolveQmdEntry();

// qmd is OPTIONAL in this template: every self-heal path below is gated on
// a resolvable install (`qmdEntry !== null`). A machine without qmd gets no
// probes, no bootstrap spawn, no notes — the silent degradation it has today.

// Self-heal a BROKEN qmd install, distinct from a missing one: if a Node
// upgrade leaves @tobilu/qmd's native `better-sqlite3` binding compiled
// against the wrong ABI, every invocation crashes before it opens the store
// — the sqlite file can be tens of MB and perfectly healthy, and the
// fire-and-forget re-index spawn swallows the crash, so semantic search
// goes silently dark. Bounded to a status call (cheap, touches the store)
// + a rebuild (the actual fix) — both timeboxed so a hung native build
// can't blow the hook's timeout.
let qmdSelfHealNote: string | null = null;
if (qmdIndex !== null && qmdEntry !== null) {
	const preflightCmd = buildQmdCommand(qmdEntry, [
		"--index",
		qmdIndex,
		"status",
	]);
	const preflight = spawnSync(preflightCmd.cmd, preflightCmd.args as string[], {
		encoding: "utf-8",
		timeout: 5_000,
		shell: preflightCmd.shell,
	});
	if (isQmdNativeAbiMismatch(preflight.stderr ?? "")) {
		const pkgRoot = qmdPackageRootFromEntry(qmdEntry);
		if (pkgRoot !== null) {
			const rebuild = spawnSync("npm rebuild better-sqlite3", {
				cwd: pkgRoot,
				encoding: "utf-8",
				timeout: 20_000,
				shell: true,
			});
			qmdSelfHealNote =
				rebuild.status === 0
					? "⚠️ QMD's native module (better-sqlite3) was ABI-mismatched against this machine's Node version — auto-rebuilt this session. Semantic search may need one more `qmd update` to fully catch up; if the qmd MCP tools are still absent, a session restart picks them up."
					: "⚠️ QMD's native module (better-sqlite3) is ABI-mismatched against this machine's Node version, and the automatic `npm rebuild better-sqlite3` did not complete cleanly — semantic search is likely dead. Manual fix: `npm rebuild better-sqlite3` inside the @tobilu/qmd package directory, then `qmd update`.";
		}
	}
}

// Min-version check (#100): warn-only here — a session must never be broken
// by an old qmd, but a silently-old install shouldn't stay silent either.
// Runs only when the manifest opts in via `qmd_min_version` AND qmd is
// installed. The bootstrap enforces the same floor loudly.
let qmdVersionNote: string | null = null;
const qmdMinVersion = parseQmdMinVersion(manifestJson);
if (qmdMinVersion !== null && qmdEntry !== null) {
	const versionCmd = buildQmdCommand(qmdEntry, ["--version"]);
	const v = spawnSync(versionCmd.cmd, versionCmd.args as string[], {
		encoding: "utf-8",
		timeout: 5_000,
		shell: versionCmd.shell,
	});
	if (v.status === 0 && !qmdVersionAtLeast(v.stdout ?? "", qmdMinVersion)) {
		qmdVersionNote = `⚠️ Installed qmd (${(v.stdout ?? "").trim()}) is below this vault's declared minimum (${qmdMinVersion}) — semantic search may misbehave. Update: \`npm i -g @tobilu/qmd\`, then re-run the bootstrap.`;
	}
}

// Self-heal a machine that hasn't bootstrapped QMD yet: the store is
// machine-local derived data (~/.cache/qmd/<index>.sqlite, never committed),
// so a clean clone has no registered collection — and `qmd update` silently
// no-ops forever in that state, leaving semantic search dead with no error
// (an empty shell store can still exist at ~100KB; a populated one is tens
// of MB). If the store is missing or implausibly small, run the idempotent
// bootstrap (registers collection + context + index + embed) instead of
// `update`. Threshold errs toward bootstrapping: it's safe to re-run by
// design. Gated on an installed qmd — never bootstraps onto a machine that
// hasn't opted into qmd at all.
function qmdStoreLooksEmpty(index: string | null): boolean {
	if (!index) return false; // no named index → keep legacy update behavior
	try {
		// XDG-aware, matching qmd's own store path — a hardcoded ~/.cache
		// would force a full bootstrap every session for XDG_CACHE_HOME users.
		const store = resolveIndexStorePath(index, process.env, homedir());
		return statSync(store).size < 500_000;
	} catch {
		return true; // store missing / path differs → bootstrap (idempotent)
	}
}

const bootstrapNeeded = qmdEntry !== null && qmdStoreLooksEmpty(qmdIndex);
const qmdUpdate = bootstrapNeeded
	? {
			cmd: process.execPath,
			args: ["--experimental-strip-types", "scripts/qmd-bootstrap.ts"],
			shell: false,
		}
	: buildQmdCommand(qmdEntry, qmdArgsWithIndex(qmdIndex, ["update"]));
// Bootstrap resolves the script + vault-manifest.json relative to the vault
// cwd; the update path pins cwd to tmpdir. `cwd: tmpdir()` keeps the
// detached child from holding the vault dir as its working directory —
// `qmd update --index <name>` reads collection paths from YAML, so cwd is
// irrelevant to the work, and pinning it to the OS tmpdir means `rm -rf`
// of the vault (or a test cleanup) never races a stale qmd handle on
// Windows.
const qmdCwd = bootstrapNeeded ? cwd : tmpdir();
const qmdChild = spawn(qmdUpdate.cmd, qmdUpdate.args as string[], {
	stdio: "ignore",
	shell: qmdUpdate.shell,
	detached: true,
	windowsHide: true,
	cwd: qmdCwd,
});
// Silence the spawn-error event so a missing qmd doesn't crash the hook;
// qmd is optional and the hook already degrades when it's not installed.
qmdChild.on("error", () => undefined);
qmdChild.unref();

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
	//
	// The 30-line budget must carry LIVE goals (#107): anchor at
	// "## Current Focus" (skipping frontmatter + preamble) and drop
	// struck-through completed bullets, which otherwise consume the slice
	// and truncate current strategy.
	try {
		const raw = readFileSync("brain/North Star.md", { encoding: "utf-8" });
		const lines = stripFrontmatter(raw).split("\n");
		const anchor = lines.findIndex((l) =>
			l.trim().startsWith("## Current Focus"),
		);
		const scoped = anchor >= 0 ? lines.slice(anchor) : lines;
		const struckCount = scoped.filter((l) =>
			l.trimStart().startsWith("- ~~"),
		).length;
		const live = scoped.filter((l) => !l.trimStart().startsWith("- ~~"));
		if (struckCount > 0) {
			// Struck bullets can carry live tails — keep a pointer so sessions
			// know completed context exists in the file.
			live.splice(
				1,
				0,
				`_(${struckCount} completed item${struckCount === 1 ? "" : "s"} hidden — full history in brain/North Star.md)_`,
			);
		}
		return take(live.join("\n"), 30);
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
		.filter((e) => e.isFile() && isMarkdownFilename(e.name))
		.map((e) => e.name)
		.sort();
	const parsed = files.map((f) => {
		const name = f.replace(/\.md$/i, "");
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

// High-volume dirs the listing collapses to one count line (#107): the
// archive grows forever and its enumeration is orientation noise — Glob
// or QMD reach it on demand.
const COLLAPSED_DIRS: readonly string[] = ["work/archive"];

function countMd(dir: string): number {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let n = 0;
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) n += countMd(full);
		else if (e.isFile() && isMarkdownFilename(e.name)) n += 1;
	}
	return n;
}

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
			if (e.isDirectory()) {
				const posix = full.replaceAll("\\", "/");
				if (COLLAPSED_DIRS.includes(posix)) {
					results.push(
						`./${posix}/ — ${countMd(full)} notes (listing collapsed — Glob or QMD on demand)`,
					);
					continue;
				}
				walk(full);
			} else if (e.isFile() && isMarkdownFilename(e.name)) results.push(`./${full}`);
		}
	}
	walk(".");
	return results.sort();
}

// Source-aware assembly (#107): on resume/compact the static bulk (North
// Star, brain index, file listing) is already in-conversation — a pointer
// replaces it, and only the volatile sections (recent changes, tasks,
// active work, hygiene, QMD notes) re-inject.
const sections = [
	"## Session Context",
	"",
	"### Date",
	formatDateHeader(new Date()),
	"",
];
if (mode === "full") {
	sections.push(
		"### North Star (current goals)",
		northStar(),
		"",
		"### Brain Topics (read on demand)",
		brainIndex(),
		"",
	);
}
sections.push(
	"### Recent Changes (last 48h)",
	recentChanges(),
	"",
	"### Open Tasks",
	openTasks(),
	"",
	"### Active Work",
	activeWork(),
);
if (mode === "full") {
	sections.push("", "### Vault File Listing", listMd().join("\n"));
} else {
	sections.push(
		"",
		"### Context Pointer",
		"(Re-entry via resume/compact — North Star, brain index, and the file listing were injected at session start and are unchanged; re-read on demand.)",
	);
}

if (qmdSelfHealNote !== null) {
	sections.push("", "### QMD Self-Heal", qmdSelfHealNote);
}
if (qmdVersionNote !== null) {
	sections.push("", "### QMD Version", qmdVersionNote);
}

// Hygiene drift flags (#98/#103/#106): silent when the vault is clean, so
// the section only spends tokens when it has something to say.
const hygieneLines = formatActiveHygiene(
	scanActiveHygiene(
		cwd,
		Date.now(),
		parseOpenLoopConfig(manifestJson),
		infraRootFilenames,
	),
);
if (hygieneLines.length > 0) {
	sections.push("", "### Vault Hygiene (drift detected)", hygieneLines.join("\n"));
}

const body = sections.join("\n") + "\n";
process.stdout.write(
	body + "\n" + formatInjectionSize(Buffer.byteLength(body, "utf-8")) + "\n",
);
