/**
 * Sync `.obsidian/app.json` userIgnoreFilters into QMD's per-index YAML
 * config so both engines hide the same files from search. Called during
 * bootstrap; the QMD mid-session refresh hook picks up the result the next
 * time `qmd update` runs (which reads the YAML on every invocation).
 *
 * Split into a pure YAML transform (`upsertIgnoreInYaml`) plus file-IO
 * wrappers (`readObsidianIgnore`, `writeQmdIgnore`, `qmdConfigPath`) so the
 * surgical YAML editing logic is unit-testable without temp files.
 *
 * The YAML surgery is a targeted regex edit rather than a full YAML rewrite:
 * QMD owns the file schema and exposes advanced fields (update command,
 * includeByDefault) we don't want to silently strip on round-trip.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { warn } from "./hook-io.ts";
import { escapeRegex } from "./regex.ts";

/**
 * YAML indent widths used by QMD's serializer. Defined once here so the strip
 * regex, header regex, and block builder all use the same values — a schema
 * change only needs to update these constants.
 */
const COLLECTION_INDENT = "  "; // 2 spaces — `  <collection-name>:`
const FIELD_INDENT = "    "; // 4 spaces — `    pattern: …`, `    ignore:`
const LIST_ITEM_INDENT = "      "; // 6 spaces — `      - pattern`

/**
 * Matches a full `ignore:` block inside a QMD collection entry: the field-indent
 * `ignore:` header plus one or more list-item-indent entries. Used to strip any
 * existing block before re-injecting, keeping the YAML transform idempotent.
 */
const IGNORE_BLOCK_RE = new RegExp(
	`^${FIELD_INDENT}ignore:\\n(?:${LIST_ITEM_INDENT}- .*\\n)+`,
	"gm",
);

/**
 * Obsidian's app.json `userIgnoreFilters` is the single source of truth for
 * what's hidden from both Obsidian and QMD search. Bootstrap reads it and
 * writes the patterns to the QMD YAML so `qmd update` skips the same files.
 *
 * Path defaults to `.obsidian/app.json` resolved against the current working
 * directory — the script is expected to run from the vault root. Tests inject
 * a temp path through the parameter.
 */
export function readObsidianIgnore(
	appJsonPath: string = ".obsidian/app.json",
): readonly string[] {
	// No existsSync pre-check: the catch below already returns [] on ENOENT,
	// so an extra syscall to pre-verify only buys a TOCTOU race.
	try {
		const parsed = JSON.parse(readFileSync(appJsonPath, "utf-8")) as {
			userIgnoreFilters?: unknown;
		};
		const raw = parsed.userIgnoreFilters;
		if (!Array.isArray(raw)) return [];
		return raw.filter((v): v is string => typeof v === "string");
	} catch {
		return [];
	}
}

/**
 * Translate one Obsidian `userIgnoreFilters` entry into a fastGlob pattern.
 *
 * Obsidian's format: plain strings match as "path startsWith"; strings wrapped
 * in `/…/` are regex. fastGlob (QMD's walker) doesn't speak regex, so regex
 * entries return null and the caller drops them. Plain filenames pass through
 * — they match identically in both engines. A bare `foo/` becomes `foo/**`
 * so glob semantics cover everything under the folder.
 */
export function translateToGlob(pattern: string): string | null {
	if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 1) {
		return null;
	}
	if (pattern.endsWith("/")) return `${pattern}**`;
	return pattern;
}

export function qmdConfigPath(indexName: string): string {
	return join(homedir(), ".config", "qmd", `${indexName}.yml`);
}

/**
 * Pure YAML transform: given the current file content, return new content with
 * the collection's `ignore:` block set to the supplied patterns. Empty patterns
 * strips any existing block. Returns null when the named collection isn't
 * present — distinct from "no change needed" so callers can warn on drift.
 */
export function upsertIgnoreInYaml(
	content: string,
	collectionName: string,
	patterns: readonly string[],
): string | null {
	// Strip any existing ignore: block anywhere in the file. Safe even with
	// multiple collections: we re-inject only into the named one below.
	const stripped = content.replace(IGNORE_BLOCK_RE, "");
	const headerRe = new RegExp(
		`(^${COLLECTION_INDENT}${escapeRegex(collectionName)}:\\n(?:${FIELD_INDENT}[^\\n]*\\n)*?${FIELD_INDENT}pattern: [^\\n]*\\n)`,
		"m",
	);
	if (!headerRe.test(stripped)) return null;
	if (patterns.length === 0) return stripped;

	const block =
		`${FIELD_INDENT}ignore:\n` +
		patterns
			.map((p) => `${LIST_ITEM_INDENT}- ${JSON.stringify(p)}`)
			.join("\n") +
		"\n";
	return stripped.replace(headerRe, `$1${block}`);
}

/**
 * File-IO wrapper around upsertIgnoreInYaml. Reports via stderr when the
 * config file is missing or the named collection isn't present so bootstrap
 * runs surface configuration drift without aborting.
 */
export function writeQmdIgnore(
	configPath: string,
	collectionName: string,
	patterns: readonly string[],
): boolean {
	let before: string;
	try {
		before = readFileSync(configPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			warn(
				`QMD config not found at ${configPath}; skipping ignore propagation.`,
			);
			return false;
		}
		throw err;
	}
	const next = upsertIgnoreInYaml(before, collectionName, patterns);
	if (next === null) {
		warn(
			`Could not locate collection '${collectionName}' in ${configPath}; ignore not applied.`,
		);
		return false;
	}
	if (next !== before) writeFileSync(configPath, next, "utf-8");
	return true;
}
