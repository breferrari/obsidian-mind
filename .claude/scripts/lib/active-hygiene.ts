/**
 * Active-folder hygiene scan — shared by the SessionStart and Stop hooks
 * (#98/#103), plus the write-time detectors validate-write.ts consumes.
 *
 * Drift modes surfaced:
 *
 *   1. COMPLETED-NOT-ARCHIVED — a note whose frontmatter `status` is
 *      `completed`/`archived`/`done` but is still sitting in `work/active/`.
 *      It pollutes the SessionStart task aggregation and the Work Dashboard
 *      Base, and it's how the pile forms (every deferred archive starts
 *      here).
 *
 *   2. UNGROUPED MULTI-FILE TOPIC — two or more notes sitting *loose in the
 *      active/ root* (not in a subfolder) that share a distinctive topic
 *      token. Convention: once a workstream has >1 note, it gets a folder
 *      (`active/<Topic>/`). This catches clusters before they scatter.
 *
 *   3. OVERSIZED NOTES — past ~25KB a note has outgrown one node and wants
 *      a SPLIT, never trimming. Bytes, not lines: giant single-line entries
 *      hide in low line counts.
 *
 *   4. OPEN LOOPS (#106) — follow-up surfaces (1:1 action items, meeting
 *      follow-ups, incident watch-fors) with live signals that went quiet.
 *      Watch dirs and section headings are manifest-configurable so a
 *      reshaped vault retargets its own surfaces without code edits.
 *
 *   5. MEETINGS-INBOX PRESSURE — work/meetings/ is a staging inbox drained
 *      by /om-intake; raw exports sitting there are unprocessed by
 *      definition.
 *
 * Philosophy: pattern-based, no LLM, conservative. This NUDGES — it never
 * moves files. False negatives (missing a cluster) are preferable to false
 * positives (nagging about unrelated notes), so the cluster detector leans
 * hard on a document-frequency guard: a token shared by *more than half*
 * the root notes is treated as a generic team/element word, not a groupable
 * topic.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { escapeRegex } from "./regex.ts";
import {
	extractFrontmatterField,
	isInfraFilename,
	isMarkdownFilename,
} from "./session-start.ts";

const ACTIVE_REL = "work/active";

// Frontmatter status values that mean "this should not be in active/".
const ARCHIVABLE_STATUS = new Set(["completed", "archived", "done"]);

// Generic process words that must never anchor a topic cluster. The
// document-frequency guard catches most of these already (a word in >50%
// of root notes is excluded), but common nouns can slip under that in a
// small active/ — so we hard-stop the worst offenders. Kept short on
// purpose; over-stopwording would suppress real project nouns.
const STOPWORDS = new Set([
	"onboarding", "branch", "the", "and", "for", "with", "from", "into",
	"that", "this", "report", "plan", "sync", "call", "prep", "notes",
	"doc", "document", "meeting", "review", "draft", "log", "investigation",
	"framework", "roadmap", "playbook", "support", "screen", "verification",
	"remediation", "delivery", "strategy", "execution", "kickoff",
	"discovery", "prompt", "audit", "analysis", "experiment",
]);

// Strip a leading `YYYY-MM-DD ` date prefix and the `.md` extension, then
// tokenise the title into lowercased alphanumeric words.
function titleTokens(filename: string): string[] {
	const title = filename
		.replace(/\.md$/i, "")
		.replace(/^\d{4}-\d{2}-\d{2}\s+/, "");
	return title
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}

export type TopicCluster = {
	readonly token: string;
	readonly files: readonly string[]; // root-level filenames
};

export type OversizedNote = {
	readonly path: string; // vault-relative
	readonly sizeKb: number;
};

export type OpenLoop = {
	readonly path: string; // vault-relative
	readonly ageDays: number;
	readonly openItems: number;
};

export type InboxPressure = {
	readonly count: number;
	readonly oldestDays: number;
};

export type ActiveHygieneReport = {
	// Vault-relative paths (e.g. "work/active/Foo.md").
	readonly completedInActive: readonly string[];
	readonly ungroupedClusters: readonly TopicCluster[];
	readonly oversizedNotes: readonly OversizedNote[];
	readonly openLoops: readonly OpenLoop[];
	readonly inboxPressure: InboxPressure | null;
};

// ---------------------------------------------------------------------------
// Open-loops detection (#106). Conservative by design (false negatives over
// nagging): checkboxes count only inside their follow-up sections, dirs of
// per-person dated notes scan only the LATEST note per person (older notes'
// items are historical carry-forwards), and output is capped. Hook output
// prints paths + counts ONLY — never the matched line content (follow-up
// lines can be sensitive, and hook output may be pasted anywhere).
// ---------------------------------------------------------------------------

export const OPEN_LOOP_DAYS = 14;
export const OPEN_LOOP_CAP = 5;
const OPEN_LOOP_DEFAULT_DIRS = ["work/1-1", "work/meetings", "work/incidents"];
const OPEN_LOOP_DEFAULT_SECTIONS = ["action items", "what to watch"];
const OPEN_LOOP_PHRASE = /\b(waiting on|watch for)\b/i;

export type OpenLoopConfig = {
	readonly dirs: readonly string[];
	readonly sectionRe: RegExp;
};

/**
 * Read the open-loops watch surfaces from the manifest: `open_loop_dirs`
 * (vault-relative directories) and `open_loop_sections` (heading names,
 * matched case-insensitively). Different vault shapes have different
 * follow-up surfaces — the detector is the invariant, the surfaces are
 * config. Missing/malformed fields fall back to the template defaults.
 */
export function parseOpenLoopConfig(manifestJson: string | null): OpenLoopConfig {
	let dirs: readonly string[] = OPEN_LOOP_DEFAULT_DIRS;
	let sections: readonly string[] = OPEN_LOOP_DEFAULT_SECTIONS;
	if (manifestJson !== null) {
		try {
			const parsed = JSON.parse(manifestJson) as Record<string, unknown>;
			const d = parsed["open_loop_dirs"];
			if (
				Array.isArray(d) &&
				d.length > 0 &&
				d.every((x) => typeof x === "string" && x.length > 0)
			) {
				dirs = d as string[];
			}
			const s = parsed["open_loop_sections"];
			if (
				Array.isArray(s) &&
				s.length > 0 &&
				s.every((x) => typeof x === "string" && x.length > 0)
			) {
				sections = s as string[];
			}
		} catch {
			/* malformed manifest → defaults */
		}
	}
	const sectionRe = new RegExp(
		`^##+\\s+(${sections.map((s) => escapeRegex(s)).join("|")})`,
		"i",
	);
	return { dirs, sectionRe };
}

/**
 * Count live follow-up signals in a note: unchecked `- [ ]` items inside a
 * configured follow-up section, plus explicit waiting-on / watch-for lines
 * anywhere. Pure — exported for tests.
 */
export function countOpenLoops(content: string, sectionRe: RegExp): number {
	let inActionSection = false;
	let count = 0;
	for (const line of content.split("\n")) {
		if (/^##+\s/.test(line)) {
			inActionSection = sectionRe.test(line);
			continue;
		}
		const unchecked = /^\s*-\s\[\s\]/.test(line);
		if (inActionSection && unchecked) count++;
		else if (OPEN_LOOP_PHRASE.test(line)) count++;
	}
	return count;
}

/** `<Person> YYYY-MM-DD.md` → person key, or null for non-1:1-shaped names. */
function oneOnOnePersonKey(filename: string): string | null {
	const m = filename.match(/^(.+?)\s+\d{4}-\d{2}-\d{2}\.md$/i);
	return m?.[1] ?? null;
}

/**
 * The latest-per-person reduction applies only to 1:1-style dirs (name
 * contains "1-1" or "1on1") — elsewhere a date-suffixed title like
 * "Weekly Sync 2026-07-01.md" would false-match the person shape and
 * silently drop older meeting notes from the scan.
 */
function isOneOnOneDir(relDir: string): boolean {
	return /1-?on?-?1|1-1/i.test(relDir.split("/").pop() ?? relDir);
}

function findOpenLoops(
	root: string,
	nowMs: number,
	config: OpenLoopConfig,
): OpenLoop[] {
	const candidates: string[] = [];
	for (const dir of config.dirs) {
		const files = walkMarkdown(root, dir);
		if (isOneOnOneDir(dir)) {
			const latestByPerson = new Map<string, string>();
			for (const rel of files.sort()) {
				const base = rel.split("/").pop() ?? rel;
				const person = oneOnOnePersonKey(base);
				if (person === null) continue; // non-1:1-shaped → skip (conservative)
				latestByPerson.set(person, rel); // sorted → last wins = latest date
			}
			candidates.push(...latestByPerson.values());
		} else {
			candidates.push(...files);
		}
	}

	const out: OpenLoop[] = [];
	for (const rel of candidates) {
		// Archive notes hold historical bulk by convention — a "waiting on"
		// line in an archive is a record, not a live loop.
		if ((rel.split("/").pop() ?? "").includes("Archive")) continue;
		let content: string;
		let mtimeMs: number;
		try {
			const full = join(root, rel);
			content = readFileSync(full, "utf-8");
			mtimeMs = statSync(full).mtimeMs;
		} catch {
			continue;
		}
		const ageDays = Math.floor((nowMs - mtimeMs) / 86_400_000);
		if (ageDays < OPEN_LOOP_DAYS) continue;
		const openItems = countOpenLoops(content, config.sectionRe);
		if (openItems === 0) continue;
		out.push({ path: rel, ageDays, openItems });
	}
	// Oldest first, capped — surface the longest-dead loops, stay quiet-ish.
	return out.sort((a, b) => b.ageDays - a.ageDays).slice(0, OPEN_LOOP_CAP);
}

// ---------------------------------------------------------------------------
// Oversized-note detection. Size is a STRUCTURE signal, never a brevity
// signal: past the threshold a note wants a SPLIT (domain notes / event-log
// satellites / a cluster folder — verbatim, index left behind), never
// trimming. Vault-wide by design — existing large chronological logs flag
// immediately and become the split backlog, not noise.
// ---------------------------------------------------------------------------

export const MONOLITH_BYTES = 25_000;

/** Archive notes are bulk by design — the only exemption. */
export function isMonolithExempt(filename: string): boolean {
	return filename.includes("Archive");
}

// Never walked for oversize: machinery and non-note trees.
const OVERSIZE_SKIP_DIRS = new Set([
	".git",
	".obsidian",
	".claude",
	".codex",
	".gemini",
	".github",
	".shardmind",
	".qmd",
	"node_modules",
	"templates",
]);

// Recursively collect .md files under a directory, returning paths relative
// to `root`. Tolerates a missing directory (returns []). Shared by every
// detector so subfoldered workstreams are never skipped (#104).
export function walkMarkdown(root: string, relDir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, relDir), { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		const rel = `${relDir}/${e.name}`;
		if (e.isDirectory()) out.push(...walkMarkdown(root, rel));
		else if (e.isFile() && isMarkdownFilename(e.name)) out.push(rel);
	}
	return out;
}

function findCompletedInActive(root: string): string[] {
	const found: string[] = [];
	for (const rel of walkMarkdown(root, ACTIVE_REL)) {
		let content: string;
		try {
			content = readFileSync(join(root, rel), "utf-8");
		} catch {
			continue;
		}
		const status = extractFrontmatterField(content, "status");
		if (status && ARCHIVABLE_STATUS.has(status.toLowerCase())) {
			found.push(rel);
		}
	}
	return found.sort();
}

function findUngroupedClusters(root: string): TopicCluster[] {
	// Only files DIRECTLY in active/ root — anything already in a subfolder
	// is considered grouped.
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, ACTIVE_REL), { withFileTypes: true });
	} catch {
		return [];
	}
	const rootFiles = entries
		.filter((e) => e.isFile() && isMarkdownFilename(e.name))
		.map((e) => e.name);

	// Don't nag about grouping when the root is already small — folders are
	// for taming size, not for ceremony.
	if (rootFiles.length < 4) return [];

	// token -> set of filenames containing it
	const byToken = new Map<string, Set<string>>();
	for (const f of rootFiles) {
		for (const t of new Set(titleTokens(f))) {
			(byToken.get(t) ?? byToken.set(t, new Set()).get(t)!).add(f);
		}
	}

	// A token is a groupable topic if it appears in >=2 root files but in no
	// more than half of them (the DF guard that rejects generic words).
	const dfCap = Math.floor(rootFiles.length / 2);
	const clusters: TopicCluster[] = [];
	const seenSignatures = new Set<string>();
	for (const [token, set] of byToken) {
		if (set.size < 2 || set.size > dfCap) continue;
		const files = [...set].sort();
		// Dedup tokens that produce the same file set.
		const sig = files.join("|");
		if (seenSignatures.has(sig)) continue;
		seenSignatures.add(sig);
		clusters.push({ token, files });
	}
	// Largest clusters first; ties broken by token for stable output.
	return clusters.sort(
		(a, b) => b.files.length - a.files.length || a.token.localeCompare(b.token),
	);
}

function findOversizedNotes(
	root: string,
	infraRootFilenames: readonly string[],
): OversizedNote[] {
	const out: OversizedNote[] = [];
	function walk(relDir: string): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(join(root, relDir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
			if (e.isDirectory()) {
				if (relDir === "" && OVERSIZE_SKIP_DIRS.has(e.name)) continue;
				walk(rel);
			} else if (e.isFile() && isMarkdownFilename(e.name)) {
				if (isMonolithExempt(e.name)) continue;
				// Root-level infrastructure docs (README + translations,
				// CLAUDE.md, …) are repo files, not vault notes — their bulk
				// is not a split candidate.
				if (relDir === "" && isInfraFilename(e.name, infraRootFilenames))
					continue;
				try {
					const size = statSync(join(root, rel)).size;
					if (size >= MONOLITH_BYTES) {
						out.push({ path: rel, sizeKb: Math.round(size / 1000) });
					}
				} catch {
					/* unreadable → skip */
				}
			}
		}
	}
	walk("");
	return out.sort((a, b) => b.sizeKb - a.sizeKb);
}

// ---------------------------------------------------------------------------
// Meetings-inbox pressure. work/meetings/ is a staging inbox drained by
// /om-intake — raw exports sitting there are unprocessed by definition.
// ---------------------------------------------------------------------------

export const INBOX_PRESSURE_DAYS = 7;

function findInboxPressure(root: string, nowMs: number): InboxPressure | null {
	let count = 0;
	let oldestDays = 0;
	for (const rel of walkMarkdown(root, "work/meetings")) {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(join(root, rel)).mtimeMs;
		} catch {
			continue;
		}
		const ageDays = Math.floor((nowMs - mtimeMs) / 86_400_000);
		if (ageDays < INBOX_PRESSURE_DAYS) continue;
		count++;
		if (ageDays > oldestDays) oldestDays = ageDays;
	}
	return count > 0 ? { count, oldestDays } : null;
}

// ---------------------------------------------------------------------------
// Write-time detectors — the same logic the scan uses, moved to the moment
// of write so drift is caught at the keystroke instead of the next session
// boundary. validate-write.ts calls these.
// ---------------------------------------------------------------------------

/**
 * Write-time cluster sensor: when the just-written note sits loose in the
 * active/ root and joins a distinctive-token cluster, return that cluster.
 * Reuses findUngroupedClusters wholesale — same tokenizer, same DF guard,
 * same small-root skip — so scan-time and write-time can never disagree.
 */
export function newNoteClusterCandidate(
	filePath: string,
	vaultRoot: string,
): TopicCluster | null {
	const normalized = filePath.replaceAll("\\", "/");
	const rootPrefix = `${vaultRoot.replaceAll("\\", "/")}/${ACTIVE_REL}/`;
	if (!normalized.startsWith(rootPrefix)) return null;
	const base = normalized.slice(rootPrefix.length);
	if (base.includes("/")) return null; // already in a topic folder
	for (const cluster of findUngroupedClusters(vaultRoot)) {
		if (cluster.files.includes(base)) return cluster;
	}
	return null;
}

export function formatClusterHint(cluster: TopicCluster): string {
	return [
		`🗂️  This note joins ${cluster.files.length - 1} loose sibling(s) in active/ sharing "${cluster.token}": ${cluster.files.join(", ")}.`,
		"Convention: once a workstream has >1 note it gets a folder (active/<Topic>/, `git mv`, mirror the folder in archive/ later).",
		"Token overlap is BLIND — judge whether these genuinely share context before grouping; if they don't, say so and move on.",
	].join("\n");
}

export function formatMonolithHint(path: string, sizeBytes: number): string {
	return `📐 \`${path}\` is now ${Math.round(sizeBytes / 1000)}KB — past the ${MONOLITH_BYTES / 1000}KB organization threshold. Do NOT trim the content; SPLIT it while you have the context: domain notes / event-log satellites / a cluster folder, moved verbatim, with a one-liner index left behind and inbound links retargeted. If a split genuinely doesn't fit yet, say why in the session instead of ignoring this.`;
}

export function scanActiveHygiene(
	root: string,
	nowMs: number = Date.now(),
	openLoopConfig: OpenLoopConfig = parseOpenLoopConfig(null),
	infraRootFilenames: readonly string[] = [],
): ActiveHygieneReport {
	return {
		completedInActive: findCompletedInActive(root),
		ungroupedClusters: findUngroupedClusters(root),
		oversizedNotes: findOversizedNotes(root, infraRootFilenames),
		openLoops: findOpenLoops(root, nowMs, openLoopConfig),
		inboxPressure: findInboxPressure(root, nowMs),
	};
}

/**
 * Render the report as markdown lines for hook output. Returns [] when the
 * vault is clean, so callers can skip emitting a section entirely.
 */
export function formatActiveHygiene(report: ActiveHygieneReport): string[] {
	const {
		completedInActive,
		ungroupedClusters,
		oversizedNotes,
		openLoops,
		inboxPressure,
	} = report;
	if (
		completedInActive.length === 0 &&
		ungroupedClusters.length === 0 &&
		oversizedNotes.length === 0 &&
		openLoops.length === 0 &&
		inboxPressure === null
	) {
		return [];
	}
	const lines: string[] = [];

	if (completedInActive.length > 0) {
		lines.push(
			`⚠️  ${completedInActive.length} note(s) marked done but still in active/ — archive to archive/YYYY/ (try /om-project-archive):`,
		);
		for (const p of completedInActive) lines.push(`   - ${p}`);
	}

	if (ungroupedClusters.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			"⚠️  Loose active/ notes that look like one topic — consider a folder (active/<Topic>/):",
		);
		for (const { token, files } of ungroupedClusters) {
			lines.push(`   - "${token}": ${files.join(", ")}`);
		}
	}

	if (oversizedNotes.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${oversizedNotes.length} note(s) past the ${MONOLITH_BYTES / 1000}KB organization threshold — do NOT trim content; SPLIT (domain notes / event-log satellites / a cluster folder, verbatim, one-liner index behind):`,
		);
		for (const { path, sizeKb } of oversizedNotes) {
			lines.push(`   - ${path} (${sizeKb}KB)`);
		}
	}

	if (openLoops.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${openLoops.length} note(s) with open follow-ups untouched ${OPEN_LOOP_DAYS}+ days — close, chase, or consciously park (paths + counts only by design):`,
		);
		for (const { path, ageDays, openItems } of openLoops) {
			lines.push(`   - ${path} (${ageDays}d, ${openItems} open item(s))`);
		}
	}

	if (inboxPressure !== null) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${inboxPressure.count} raw export(s) sitting in work/meetings/ for ${INBOX_PRESSURE_DAYS}+ days (oldest ${inboxPressure.oldestDays}d) — run /om-intake to drain the inbox.`,
		);
	}

	return lines;
}
