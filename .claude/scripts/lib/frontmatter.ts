/**
 * Validation logic for the validate-write hook: path skip rules, required
 * frontmatter fields, and wikilink presence on non-trivial notes.
 */

import { basename, posix } from "node:path";
import { readFileSync } from "node:fs";
import { hardWrappedParagraphs } from "./prose-width.ts";

const ROOT_FILES: ReadonlySet<string> = new Set([
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"ARCHITECTURE.md",
	"CLAUDE.md",
	"AGENTS.md",
	"GEMINI.md",
]);

const SKIP_PATH_SEGMENTS: readonly string[] = [
	".claude/",
	".codex/",
	".gemini/",
	".github/",
	".obsidian/",
	"templates/",
	"thinking/",
];

/**
 * Return true if the path is an auto-memory file in ~/.claude/ that should
 * be flagged (#81). Only MEMORY.md (the auto-loaded index) is allowed there
 * — all durable knowledge goes to brain/ topic notes per CLAUDE.md.
 *
 * The path is lexically normalized first (separators unified, `.`/`..`
 * segments collapsed) so a path can't dodge the check by spelling the
 * memory dir indirectly. Callers should additionally pass a
 * realpath-resolved path when the file exists, so symlinked spellings are
 * caught too — see the guard in validate-write.ts.
 *
 * The predicate requires BOTH `/.claude/` and `/memory/` segments and
 * exempts `MEMORY.md` by basename, so it never fires on vault paths like
 * `brain/Memories.md`, project paths containing the word "memory", or
 * other `.claude/projects/<x>/` subdirs (transcripts, hook output).
 */
export function isBlockedMemoryPath(filePath: string): boolean {
	// Separators unified FIRST, then posix-normalize: normalize() on a POSIX
	// host doesn't treat "\" as a separator, so backslash-spelled ".."
	// segments would otherwise survive uncollapsed.
	const normalized = posix.normalize(filePath.replaceAll("\\", "/"));
	if (!normalized.includes("/memory/")) return false;
	if (!normalized.includes("/.claude/")) return false;
	const base = basename(normalized);
	return base !== "MEMORY.md";
}

/**
 * Return true if the file should be skipped (not validated).
 * Skips non-markdown, dotfiles, templates, root docs, and translated READMEs.
 */
export function shouldSkipFile(filePath: string): boolean {
	if (!filePath || !filePath.endsWith(".md")) return true;

	const normalized = filePath.replaceAll("\\", "/");
	const base = basename(normalized);

	if (ROOT_FILES.has(base)) return true;

	if (base.startsWith("README.") && base.endsWith(".md")) return true;

	for (const segment of SKIP_PATH_SEGMENTS) {
		if (normalized.includes(segment)) return true;
	}

	return false;
}

/** `vault-manifest.json`'s `frontmatter_required`: `global` plus per-type sets. */
export type FrontmatterRequired = Readonly<Record<string, readonly string[]>>;

/** Used when the manifest declares no usable `global` set. */
const DEFAULT_GLOBAL: readonly string[] = ["date", "description", "tags"];

/**
 * Which note type a vault path is, by folder. The folder→type map is
 * vault-specific; a future extension point. It mirrors the placement table
 * in CLAUDE.md and /om-vault-audit's per-type rules, which are keyed by
 * folder too. Tags cannot carry this: 1:1 notes are tagged `work-note`, yet
 * do not need a work note's `status`.
 */
const NOTE_TYPE_BY_FOLDER: readonly (readonly [string, string])[] = [
	["work/incidents/", "incident"],
	["work/1-1/", "1-1"],
	["work/active/", "work-note"],
	["work/archive/", "work-note"],
	["org/people/", "person"],
	["org/teams/", "team"],
];

export function noteTypeForPath(relPath: string): string | null {
	const p = relPath.replaceAll("\\", "/");
	for (const [prefix, type] of NOTE_TYPE_BY_FOLDER) {
		if (p.startsWith(prefix)) return type;
	}
	return null;
}

/**
 * Read `frontmatter_required` from a parsed manifest, keeping only string
 * lists. Anything malformed is dropped rather than guessed at.
 */
export function parseFrontmatterRequired(manifest: unknown): FrontmatterRequired {
	const raw = (manifest as { frontmatter_required?: unknown } | null)?.frontmatter_required;
	const out: Record<string, readonly string[]> = {};
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		for (const [type, fields] of Object.entries(raw)) {
			if (Array.isArray(fields)) {
				out[type] = fields.filter((f): f is string => typeof f === "string" && f !== "");
			}
		}
	}
	return out;
}

/**
 * The top-level keys of a frontmatter block, and its `tags`. A key counts
 * when its line exists, even with an empty value — a template-born note with
 * a blank `description:` is filled in afterwards, and was never warned
 * about. Matched as a KEY at the start of a line: `update:` is not `date`,
 * which a substring test used to accept.
 */
export function readFrontmatterKeys(fm: string): { keys: Set<string>; tags: string[] } {
	const keys = new Set<string>();
	const tags: string[] = [];
	let inTags = false;
	for (const line of fm.split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (kv) {
			const key = kv[1] as string;
			keys.add(key);
			inTags = key === "tags";
			if (inTags) {
				const v = (kv[2] ?? "").trim();
				const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
				for (const t of inner.split(",")) {
					const s = t.trim().replace(/^["']|["']$/g, "");
					if (s) tags.push(s);
				}
			}
			continue;
		}
		const item = inTags ? /^\s+-\s*(.+)$/.exec(line) : null;
		if (item) tags.push((item[1] as string).trim().replace(/^["']|["']$/g, ""));
		else if (line.trim() !== "" && !/^\s/.test(line)) inTags = false;
	}
	return { keys, tags };
}

/** The tag that marks a MAIN incident note, the only one the incident set applies to. */
const INCIDENT_ONLY_TAG = "incident";

/**
 * The fields a note must declare: the manifest's `global` set (or the
 * built-in three), plus its folder type's set. In `work/incidents/` the
 * incident set applies only to a note tagged `incident` — RCAs, deep dives
 * and drafts live beside the main note and carry the global set alone.
 */
export function requiredFieldsFor(
	required: FrontmatterRequired,
	relPath: string | null,
	tags: readonly string[],
): string[] {
	const global = required["global"]?.length ? required["global"] : DEFAULT_GLOBAL;
	const type = relPath === null ? null : noteTypeForPath(relPath);
	const typed =
		type === null || (type === "incident" && !tags.includes(INCIDENT_ONLY_TAG))
			? []
			: (required[type] ?? []);
	return [...new Set([...global, ...typed])];
}

const FIELD_MESSAGES: Readonly<Record<string, string>> = {
	tags: "Missing `tags` in frontmatter",
	description: "Missing `description` in frontmatter (~150 chars required by vault convention)",
	date: "Missing `date` in frontmatter",
};

/**
 * Inspect markdown content and return a list of warnings. Empty list means
 * the note is valid by our conventions. `required` comes from the manifest's
 * `frontmatter_required`; `relPath` (vault-relative) decides the note type.
 * Without either, the three global fields are checked, as before.
 */
export function validateContent(
	content: string,
	opts: { readonly required?: FrontmatterRequired; readonly relPath?: string | null } = {},
): string[] {
	const warnings: string[] = [];

	if (!content.startsWith("---")) {
		warnings.push("Missing YAML frontmatter");
	} else {
		const parts = content.split("---");
		if (parts.length >= 3) {
			const { keys, tags } = readFrontmatterKeys(parts[1] ?? "");
			for (const field of requiredFieldsFor(opts.required ?? {}, opts.relPath ?? null, tags)) {
				if (keys.has(field)) continue;
				warnings.push(
					FIELD_MESSAGES[field] ??
						`Missing \`${field}\` in frontmatter (required by vault-manifest.json frontmatter_required)`,
				);
			}
		}
	}

	if (content.length > 300 && !content.includes("[[")) {
		warnings.push(
			"No [[wikilinks]] found — every note must link to at least one other note (vault convention)",
		);
	}

	// #247: a wrapped note teaches the wrap to every session that reads it.
	const wrapped = hardWrappedParagraphs(content);
	if (wrapped.length > 0) {
		warnings.push(
			`${wrapped.length} hard-wrapped paragraph line(s), first at line ${wrapped[0]} — write each paragraph as one line; GitHub renders a single newline as a break (raw captures: \`verbatim: true\` in frontmatter)`,
		);
	}

	const ticketLinks = countTicketIdWikilinks(content);
	if (ticketLinks > 0) {
		warnings.push(
			`${ticketLinks} ticket-ID wikilink(s) (e.g. [[PROJ-…]]) — ticket IDs are plain text or tracker links, never wikilinks (they are not notes)`,
		);
	}

	return warnings;
}

/**
 * Count [[PROJ-12345]]-shaped wikilinks — ticket IDs are not notes, and
 * these phantom edges are what a broken-link gate later trips on (#108).
 * Matches the bare form and the table-escaped-pipe forms. Exported so
 * validate-write can emit the machine-readable policy result (#117) from
 * the same decision validateContent's prose comes from.
 */
export function countTicketIdWikilinks(content: string): number {
	return content.match(/\[\[[A-Z]{2,10}-\d+(\\\||&#124;|\||\]\])/g)?.length ?? 0;
}

/**
 * Read a file from disk and validate it. Returns null on read error
 * (caller should treat null as "skip silently" per hook protocol).
 */
export function validateFile(filePath: string): string[] | null {
	try {
		const content = readFileSync(filePath, { encoding: "utf-8" });
		return validateContent(content);
	} catch {
		return null;
	}
}
