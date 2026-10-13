/**
 * Active-folder hygiene scan — shared by the SessionStart hook and the
 * conversation-boundary hook (Stop on Claude Code and Codex, SessionEnd on
 * Gemini; #98/#103), plus the write-time detectors validate-write.ts consumes.
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
 *   6. LEFTOVER CLAUDE.md (#321) — AGENTS.md is the one instruction file,
 *      and Claude Code reads a CLAUDE.md beside it instead, silently. An
 *      update keeps a CLAUDE.md the user edited, so this says so until the
 *      user's additions are moved to .claude/rules/ and the file is gone.
 *
 * Philosophy: pattern-based, no LLM, conservative. This NUDGES — it never
 * moves files. False negatives (missing a cluster) are preferable to false
 * positives (nagging about unrelated notes), so the cluster detector leans
 * hard on a document-frequency guard: a token shared by *more than half*
 * the root notes is treated as a generic team/element word, not a groupable
 * topic.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
	AGENTS_MD_FLAG_BYTES,
	CLAUDE_MD,
	GEMINI_MD,
	GEMINI_SETTINGS,
	INSTRUCTION_FILE,
	isRetiredInstructionFile,
	RETIRED_INSTRUCTION_FILES,
} from "./instruction-files.ts";
import { escapeRegex } from "./regex.ts";
import { parsePromotedMarker, type PromotedRef } from "./memory-promoted.ts";
import {
	extractFrontmatterField,
	isInfraFilename,
	isMarkdownFilename,
	MACHINERY_DIRS,
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

/**
 * Numbers in the report that move with no new drift to act on: a note growing
 * past the threshold, an item a day older. They stay in the message but not
 * in the report's identity, and neither does the order they sort findings
 * into (lib/report-key.ts), or a note the agent keeps appending to would
 * re-show the Stop report every turn — the #252 repeat by another route.
 */
export const HYGIENE_VOLATILE_FIELDS: ReadonlySet<string> = new Set(["sizeKb", "ageDays", "oldestDays"]);

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

/**
 * The memory inbox additionally reports how many promotions are DECORATIVE.
 *
 * A separate type rather than an optional field on `InboxPressure`: the
 * meetings inbox has no promotion concept, and an optional field shared by two
 * producers is how one of them silently stops populating it.
 */
export type MemoryInboxPressure = InboxPressure & {
	/** Promoted captures whose marker carries no anchor, so nothing is servable. */
	readonly namedOnly: number;
};

export type ActiveHygieneReport = {
	// Vault-relative paths (e.g. "work/active/Foo.md").
	readonly completedInActive: readonly string[];
	readonly ungroupedClusters: readonly TopicCluster[];
	readonly oversizedNotes: readonly OversizedNote[];
	readonly openLoops: readonly OpenLoop[];
	readonly inboxPressure: InboxPressure | null;
	readonly memoryInbox: MemoryInboxPressure | null;
	/**
	 * Retired instruction files at the vault root beside AGENTS.md that still go
	 * wrong, in RETIRED_INSTRUCTION_FILES order (see LEFTOVER_HARM).
	 */
	readonly leftoverInstructionFiles: readonly string[];
	/**
	 * .gemini/settings.json exists beside AGENTS.md but Gemini cannot load it,
	 * so Gemini refuses to start (#374). Such a file retires nothing.
	 */
	readonly geminiSettingsBroken: boolean;
	/** AGENTS.md's size once it reaches AGENTS_MD_FLAG_BYTES, else null. `sizeKb`, so a report's identity ignores it (#252). */
	readonly agentsMd: { readonly sizeKb: number } | null;
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
			if (Array.isArray(d)) {
				// Vault-relative plain paths only: no absolute paths, no
				// dot-dot segments, no backslashes — a misconfigured entry
				// must not walk the scan outside the vault root.
				const valid = d.filter(
					(x): x is string =>
						typeof x === "string" &&
						x.length > 0 &&
						!x.startsWith("/") &&
						!/^[A-Za-z]:/.test(x) &&
						!x.includes("\\") &&
						!x.split("/").includes("..") &&
						!x.split("/").includes("."),
				);
				if (valid.length > 0) dirs = valid;
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
	// Raw timestamps for the sort below: floored day counts tie and then swap.
	const mtimes = new Map<string, number>();
	// Overlapping configured dirs (e.g. "work" + "work/meetings") must not
	// scan a file twice — duplicates would crowd the cap.
	for (const rel of [...new Set(candidates)]) {
		// Archive notes hold historical bulk by convention — a "waiting on"
		// line in an archive is a record, not a live loop.
		if ((rel.split("/").pop() ?? "").includes("Archive")) continue;
		// The meetings-inbox scaffold is template prose, not a follow-up
		// surface. It carries no checkboxes today, so this changes nothing
		// yet — it stops the shipped file becoming an unclearable open loop
		// the first time its instructions gain one (#155).
		if (isInboxScaffold(rel)) continue;
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
		mtimes.set(rel, mtimeMs);
		out.push({ path: rel, ageDays, openItems });
	}
	// Oldest first, capped — surface the longest-dead loops, stay quiet-ish.
	return out.sort((a, b) => (mtimes.get(a.path) ?? 0) - (mtimes.get(b.path) ?? 0) || a.path.localeCompare(b.path)).slice(0, OPEN_LOOP_CAP);
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

// Never walked for oversize: machinery (shared with the SessionStart
// listing, so the two can't drift — see MACHINERY_DIRS) plus `templates/`,
// whose files are scaffold rather than notes.
const OVERSIZE_SKIP_DIRS = new Set([...MACHINERY_DIRS, "templates"]);

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
	// Sorted so token→file maps (and the signature dedup that keeps the
	// first token per file-set) are deterministic across filesystems.
	const rootFiles = entries
		.filter((e) => e.isFile() && isMarkdownFilename(e.name))
		.map((e) => e.name)
		.sort();

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
				// AGENTS.md, …) are repo files, not vault notes — their bulk
				// is not a split candidate.
				// A retired instruction file is not a note either, whatever the
				// manifest lists: left over beside AGENTS.md it has its own flag,
				// which says to move it out, not to split it (#321).
				if (
					relDir === "" &&
					(isInfraFilename(e.name, infraRootFilenames) ||
						loadsAsRetiredInstructionFile(root, e.name))
				)
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

const INBOX_REL = "work/meetings";

/**
 * The inbox's own README ships with the template and describes how to drain
 * the folder — /om-intake never processes it, so counting it made the flag
 * permanently unclearable (#155): it fired on a genuinely empty inbox and
 * the "oldest Nd" figure climbed forever, training the reader to ignore the
 * whole hygiene block.
 *
 * Matched as an exact path, not as any README: a README a user creates
 * inside a subfolder of their own is their content, and theirs to process.
 * Compared case-insensitively because the shipped `README.md` can arrive as
 * `readme.md` through a case-insensitive checkout.
 */
function isInboxScaffold(rel: string): boolean {
	return rel.toLowerCase() === `${INBOX_REL}/readme.md`;
}

function findInboxPressure(root: string, nowMs: number): InboxPressure | null {
	let count = 0;
	let oldestDays = 0;
	for (const rel of walkMarkdown(root, INBOX_REL)) {
		if (isInboxScaffold(rel)) continue;
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
// Cross-repo memory inbox (#171). `memories/YYYY/MM/` is written by the MCP
// server on behalf of sessions in OTHER repos, and nothing has ever surfaced
// it. The meetings inbox above is watched; this one was not, so it accumulates
// in silence.
// ---------------------------------------------------------------------------

const MEMORY_ROOT_DEFAULT = "memories";

/**
 * Where the server writes cross-repo memories.
 *
 * NOT `mcp_inbox`, which is a different key for a different directory: the
 * fallback where a `record_work` call from a repo with no matching project
 * folder lands. Conflating the two is what left this unwatched, because the
 * watched one is empty by design in most vaults.
 */
export function parseMemoryRoot(manifestJson: string | null): string {
	if (manifestJson === null) return MEMORY_ROOT_DEFAULT;
	try {
		const declared = (JSON.parse(manifestJson) as Record<string, unknown>)["memory_root"];
		if (typeof declared === "string" && /^[\w.-]+$/.test(declared)) return declared;
	} catch {
		/* malformed manifest → the default */
	}
	return MEMORY_ROOT_DEFAULT;
}

/**
 * A capture already promoted into `brain/`, and kept on purpose.
 *
 * THE FLAG HAS TO BE ABLE TO REACH ZERO. Promotion is **additive**: the entry
 * stays, because `recall` reaches `brain/` only THROUGH a capture — an anchored
 * marker serves the promoted block, and there is no capture-independent path to
 * it — so deleting the capture would take the lesson away from every repo that
 * cannot read `brain/` at all. Counting every file therefore counts a number that only ever
 * grows, and a flag that cannot clear by doing the correct thing is precisely
 * the permanently-unclearable failure #155 already fixed once for the meetings
 * inbox.
 *
 * So promotion is recorded on the entry and a recorded entry stops being
 * pressure. This is the only edit a tool may make to a capture: the body, the
 * declared reach and the confidence are never touched.
 */
function promotionOf(root: string, rel: string): PromotedRef | null {
	let head: string;
	try {
		head = readFileSync(join(root, rel), "utf-8").slice(0, 2_000);
	} catch {
		return null;
	}
	const fm = head.match(/^---\n([\s\S]*?)\n---/);
	if (!fm) return null;
	// `parsePromotedMarker`, not a local regex. This was the third independent
	// parser of one format — `facetsOf` and `parsePromotedMarker` being the other
	// two — and the local one answered only "is there a marker", which is why the
	// count could not tell a servable promotion from a decorative one. (#183)
	const line = (fm[1] ?? "").match(/^promoted:\s*(.+)$/m);
	return line ? parsePromotedMarker(unquoteScalar(line[1]!.trim())) : null;
}

/** Undo the quoting the capture writer applies, so the parser sees the path. */
function unquoteScalar(s: string): string {
	if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
		return s.slice(1, -1);
	}
	return s;
}

/**
 * Captures awaiting review. Three deliberate differences from the meetings
 * inbox above.
 *
 * **No age threshold.** A capture is unreviewed because nobody has judged it
 * yet, and that is true the moment it lands. Waiting for it to go stale is how
 * a real inbox reached eighteen entries in a single day with nothing saying so.
 *
 * **Recursive.** The server writes `<root>/<YYYY>/<MM>/<title>.md`, so a flat
 * listing of the root finds nothing at all and is indistinguishable from a
 * drained inbox. `walkMarkdown` already handles this.
 *
 * **Promotion-aware**, for the reason in `isPromoted`: without it the count can
 * never fall, because the correct way to drain this inbox leaves every file
 * exactly where it is.
 */
function findMemoryInbox(root: string, relDir: string, nowMs: number): MemoryInboxPressure | null {
	let count = 0;
	let oldestDays = 0;
	let namedOnly = 0;
	for (const rel of walkMarkdown(root, relDir)) {
		// Same reasoning as the meetings scaffold (#155): a shipped README is not
		// a capture, and counting it makes the flag permanently unclearable.
		if (/\/readme\.md$/i.test(rel)) continue;
		const promoted = promotionOf(root, rel);
		if (promoted) {
			// Counted, never demanded. The inbox flag still falls on a bare marker —
			// forcing an anchor to clear hygiene would push anchors onto captures
			// whose promoted block is not fit to leave the vault. Reporting the split
			// makes the difference legible without making it mandatory. (#183)
			if (promoted.anchor === null) namedOnly++;
			continue;
		}
		let mtimeMs: number;
		try {
			mtimeMs = statSync(join(root, rel)).mtimeMs;
		} catch {
			continue;
		}
		count++;
		const ageDays = Math.floor((nowMs - mtimeMs) / 86_400_000);
		if (ageDays > oldestDays) oldestDays = ageDays;
	}
	// `count > 0` ALONE, deliberately. `namedOnly` never revives the flag: a store
	// whose captures are all promoted with bare markers is correctly drained, and
	// gating on it would rebuild the permanently-unclearable inbox that #155 fixed
	// and that the note on `promotionOf` exists to prevent. The split is a DETAIL
	// of a flag already firing; `health` reports it unconditionally, because health
	// is a report rather than a pressure. (#183)
	return count > 0 ? { count, oldestDays, namedOnly } : null;
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
		`🗂️  This note joins ${cluster.files.length - 1} loose sibling(s) in active/ sharing "${cluster.token}": ${namesCapped(cluster.files)}.`,
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
	memoryRoot: string = MEMORY_ROOT_DEFAULT,
): ActiveHygieneReport {
	return {
		completedInActive: findCompletedInActive(root),
		ungroupedClusters: findUngroupedClusters(root),
		oversizedNotes: findOversizedNotes(root, infraRootFilenames),
		openLoops: findOpenLoops(root, nowMs, openLoopConfig),
		inboxPressure: findInboxPressure(root, nowMs),
		memoryInbox: findMemoryInbox(root, memoryRoot, nowMs),
		...instructionFileFindings(root),
		agentsMd: agentsMdPastFlag(root),
	};
}

/**
 * A root file an agent loads as a retired instruction file: the exact name,
 * or another casing that the filesystem resolves to that same file (Windows,
 * macOS). On a case-sensitive filesystem a `claude.md` is a plain note, even
 * beside a real CLAUDE.md, which is a different file there. Same file means
 * the same real path, which also covers a CLAUDE.md symlinked to it; inode
 * numbers are not used, as some filesystems report them as 0.
 */
function loadsAsRetiredInstructionFile(root: string, name: string): boolean {
	if (!isRetiredInstructionFile(name)) return false;
	if (RETIRED_INSTRUCTION_FILES.includes(name)) return true;
	const real = realPath(join(root, name));
	return (
		real !== null &&
		RETIRED_INSTRUCTION_FILES.some((f) => f.toLowerCase() === name.toLowerCase() && realPath(join(root, f)) === real)
	);
}

function realPath(path: string): string | null {
	try {
		return realpathSync.native(path);
	} catch {
		return null;
	}
}

/**
 * AGENTS.md's size once it reaches the flag. It is an infrastructure file, so
 * the oversize scan never sees it, yet a user folding their additions into it
 * can push it past where Antigravity stops reading, silently.
 */
function agentsMdPastFlag(root: string): { sizeKb: number } | null {
	try {
		const size = statSync(join(root, INSTRUCTION_FILE)).size;
		return size >= AGENTS_MD_FLAG_BYTES ? { sizeKb: Math.round(size / 1000) } : null;
	} catch {
		return null;
	}
}

/**
 * Retired instruction files beside AGENTS.md that still go wrong. Without
 * AGENTS.md the vault has not upgraded yet, and its old file still carries
 * everything. A GEMINI.md counts only once Gemini's settings point it at
 * AGENTS.md: before that, Gemini still reads GEMINI.md, and deleting it would
 * cut Gemini off.
 */
function instructionFileFindings(root: string): Pick<ActiveHygieneReport, "leftoverInstructionFiles" | "geminiSettingsBroken"> {
	if (!existsSync(join(root, INSTRUCTION_FILE))) return { leftoverInstructionFiles: [], geminiSettingsBroken: false };
	// Read once, so the broken flag and the GEMINI.md verdict come from one parse.
	const gemini = geminiContextFiles(root);
	const readsAgentsMd = gemini !== "broken" && gemini.includes(INSTRUCTION_FILE) && !gemini.includes(GEMINI_MD);
	return {
		leftoverInstructionFiles: RETIRED_INSTRUCTION_FILES.filter(
			(f) => existsSync(join(root, f)) && (f !== GEMINI_MD || readsAgentsMd),
		),
		geminiSettingsBroken: gemini === "broken",
	};
}

/**
 * The context files .gemini/settings.json names, as Gemini loads it: the
 * top-level context.fileName, else the v1 contextFileName, a string or a list;
 * [] when there is no file, and "broken" when Gemini cannot load it. Gemini
 * reads the file as plain utf-8 and runs JSON.parse(stripJsonComments(text)),
 * and a failure, or a value that is not an object, is fatal: the CLI does not
 * start (gemini-cli packages/cli/src/config/settings.ts, strip-json-comments
 * 3.1.1, as of 51617c1, #374). So comments are fine, and a BOM or a trailing
 * comma is not.
 */
function geminiContextFiles(root: string): string[] | "broken" {
	let text: string;
	try {
		text = readFileSync(join(root, GEMINI_SETTINGS), "utf8");
	} catch {
		return [];
	}
	let settings: unknown;
	try {
		settings = JSON.parse(stripJsonComments(text));
	} catch {
		return "broken";
	}
	if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return "broken";
	const { context, contextFileName } = settings as { context?: { fileName?: unknown }; contextFileName?: unknown };
	const names = (context !== null && typeof context === "object" ? context.fileName : undefined) ?? contextFileName;
	return (Array.isArray(names) ? names : [names]).filter((n): n is string => typeof n === "string");
}

/**
 * strip-json-comments 3.1.1 with its default `whitespace: true`, the version
 * gemini-cli pins: a line comment to the end of its line and a block comment
 * become spaces (line breaks kept), a string (where a backslash escapes the
 * next character) is left alone, and an unterminated block comment runs to the
 * end. Where the two differ, on an unterminated string, JSON.parse fails
 * either way.
 */
export function stripJsonComments(text: string): string {
	return text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) => (m.startsWith('"') ? m : m.replace(/\S/g, " ")));
}

/** What each retired file does wrong while it stays, and what to do about it. */
const LEFTOVER_HARM: Readonly<Record<string, string>> = {
	[CLAUDE_MD]: "Claude Code reads CLAUDE.md and skips AGENTS.md; move your additions to .claude/rules/ and delete it.",
	[GEMINI_MD]:
		"Gemini no longer reads GEMINI.md: .gemini/settings.json points it at AGENTS.md. Move anything you added there to AGENTS.md and delete it.",
};

/**
 * How many entries a hygiene list prints before "… and N more". The flag's
 * headline keeps the full count. Hygiene never degrades under the injection
 * budget, so an uncapped list could fill the hook output cap by itself (#254).
 */
export const HYGIENE_LIST_CAP = 10;

/** The first HYGIENE_LIST_CAP items, and the "… and N more" tail when any were left out. */
function capped<T>(items: readonly T[]): { readonly shown: readonly T[]; readonly more: string | null } {
	const rest = items.length - HYGIENE_LIST_CAP;
	return { shown: items.slice(0, HYGIENE_LIST_CAP), more: rest > 0 ? `… and ${rest} more` : null };
}

function listCapped<T>(items: readonly T[], render: (item: T) => string): string[] {
	const { shown, more } = capped(items);
	return more === null ? shown.map(render) : [...shown.map(render), `   - ${more}`];
}

/** A cluster's file names on one line, capped the same way. */
export function namesCapped(names: readonly string[]): string {
	const { shown, more } = capped(names);
	return more === null ? shown.join(", ") : [...shown, more].join(", ");
}

/**
 * Each finding's claim: what it says, without its file list or instructions.
 * The formatter's headline opens with it, and a Stop summary is made of them
 * (lib/stop-report.ts), so the two cannot drift apart.
 */
const claims = {
	completed: (n: number) => `${n} note(s) marked done but still in active/`,
	clusters: () => "Loose active/ notes that look like one topic",
	oversized: (n: number) => `${n} note(s) past the ${MONOLITH_BYTES / 1000}KB organization threshold`,
	openLoops: (n: number) => `${n} note(s) with open follow-ups untouched ${OPEN_LOOP_DAYS}+ days`,
	inbox: (n: number) => `${n} raw export(s) sitting in work/meetings/ for ${INBOX_PRESSURE_DAYS}+ days`,
	memoryInbox: (n: number) => `${n} cross-repo memory capture(s) awaiting review`,
	leftover: (file: string) => `${file} present beside AGENTS.md`,
	geminiSettings: () => `${GEMINI_SETTINGS} doesn't parse`,
	agentsMd: (sizeKb: number) => `AGENTS.md is ${sizeKb}KB`,
};

/** The claim of every finding in `report`, in the order the formatter lists them. */
export function hygieneClaims(report: ActiveHygieneReport): string[] {
	const { completedInActive, ungroupedClusters, oversizedNotes, openLoops, inboxPressure, memoryInbox, leftoverInstructionFiles, geminiSettingsBroken, agentsMd } = report;
	const out: string[] = [];
	if (geminiSettingsBroken) out.push(claims.geminiSettings());
	for (const file of leftoverInstructionFiles) out.push(claims.leftover(file));
	if (agentsMd !== null) out.push(claims.agentsMd(agentsMd.sizeKb));
	if (completedInActive.length > 0) out.push(claims.completed(completedInActive.length));
	if (ungroupedClusters.length > 0) out.push(claims.clusters());
	if (oversizedNotes.length > 0) out.push(claims.oversized(oversizedNotes.length));
	if (openLoops.length > 0) out.push(claims.openLoops(openLoops.length));
	if (inboxPressure !== null) out.push(claims.inbox(inboxPressure.count));
	if (memoryInbox !== null) out.push(claims.memoryInbox(memoryInbox.count));
	return out;
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
		memoryInbox,
		leftoverInstructionFiles,
		geminiSettingsBroken,
		agentsMd,
	} = report;
	if (
		completedInActive.length === 0 &&
		ungroupedClusters.length === 0 &&
		oversizedNotes.length === 0 &&
		openLoops.length === 0 &&
		inboxPressure === null &&
		memoryInbox === null &&
		leftoverInstructionFiles.length === 0 &&
		!geminiSettingsBroken &&
		agentsMd === null
	) {
		return [];
	}
	const lines: string[] = [];

	// First: until they are gone, an agent reads none of the rest of the
	// conventions this vault ships in AGENTS.md, or loses what the user added.
	if (geminiSettingsBroken) {
		lines.push(
			`⚠️  ${claims.geminiSettings()} — Gemini refuses to start until it does: a BOM, a trailing comma or a syntax error is fatal there, though comments are fine. Fix the file, and keep GEMINI.md until it parses and points Gemini at AGENTS.md.`,
		);
	}
	for (const file of leftoverInstructionFiles) {
		if (lines.length > 0) lines.push("");
		const harm = LEFTOVER_HARM[file] ?? "it is a retired instruction file; move anything you added there to AGENTS.md and delete it.";
		lines.push(`⚠️  ${claims.leftover(file)} — ${harm}`);
	}

	if (agentsMd !== null) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${claims.agentsMd(agentsMd.sizeKb)} — Antigravity stopped reading it at ~24,000 bytes, silently, and Codex at ~32 KiB (Antigravity 1.3.0, Codex CLI 0.160.0, measured 2026-10-06, #321). Keep it under 23KB. Move a section an agent can safely skip to a file it reads on demand, word for word, and leave a one-line pointer; Claude Code-only additions go to .claude/rules/.`,
		);
	}

	if (completedInActive.length > 0) {
		lines.push(
			`⚠️  ${claims.completed(completedInActive.length)} — archive to archive/YYYY/ (ask the agent to run om-project-archive):`,
		);
		lines.push(...listCapped(completedInActive, (p) => `   - ${p}`));
	}

	if (ungroupedClusters.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${claims.clusters()} — consider a folder (active/<Topic>/):`,
		);
		lines.push(...listCapped(ungroupedClusters, ({ token, files }) => `   - "${token}": ${namesCapped(files)}`));
	}

	if (oversizedNotes.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${claims.oversized(oversizedNotes.length)} — do NOT trim content; SPLIT (domain notes / event-log satellites / a cluster folder, verbatim, one-liner index behind):`,
		);
		lines.push(...listCapped(oversizedNotes, ({ path, sizeKb }) => `   - ${path} (${sizeKb}KB)`));
	}

	if (openLoops.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${claims.openLoops(openLoops.length)} — close, chase, or consciously park (paths + counts only by design):`,
		);
		for (const { path, ageDays, openItems } of openLoops) {
			lines.push(`   - ${path} (${ageDays}d, ${openItems} open item(s))`);
		}
	}

	if (inboxPressure !== null) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${claims.inbox(inboxPressure.count)} (oldest ${inboxPressure.oldestDays}d) — ask the agent to run om-intake to drain the inbox.`,
		);
	}

	// Count and oldest only, never the file list. This inbox is meant to hold
	// captures between sessions, so enumerating it every session would train the
	// reader to skip the whole block.
	if (memoryInbox !== null) {
		if (lines.length > 0) lines.push("");
		lines.push(
			`⚠️  ${claims.memoryInbox(memoryInbox.count)} (oldest ${memoryInbox.oldestDays}d). Promote a durable one by COPYING it into the right brain/ note and adding \`promoted: "brain/Note#^om-a1b2c3"\` to the capture's frontmatter, pointing at the block you copied — the entry stays, because recall reaches brain/ only THROUGH a capture, so deleting it takes the lesson away from every repo that cannot read brain/ at all. The ANCHOR is what lets recall serve the corrected text; a bare \`promoted: <note>\` clears this count but serves nothing.`,
		);
		// Evidence for the sentence above, from this vault rather than in the
		// abstract. Told once the flag is already firing — it never raises one of
		// its own, because a bare marker is a legitimate promotion. (#183)
		if (memoryInbox.namedOnly > 0) {
			lines.push(
				`   ${memoryInbox.namedOnly} already-promoted capture(s) here carry a bare marker, so recall serves none of them. Re-point one by adding the anchor of the block you copied.`,
			);
		}
	}

	return lines;
}
