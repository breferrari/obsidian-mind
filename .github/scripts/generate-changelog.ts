#!/usr/bin/env node
/**
 * Generate a CHANGELOG.md entry from commits since the previous tag.
 *
 * Usage: node --experimental-strip-types generate-changelog.ts <version>
 *   e.g. generate-changelog.ts v5.0
 *
 * Outputs:
 *   - Prepends new section to CHANGELOG.md (or replaces if version exists)
 *   - Updates vault-manifest.json version and released date
 *   - Prints the generated section to stdout (for use as GitHub Release body)
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { isCovered } from "./manifest-check.ts";

const PREFIX_MAP: Readonly<Record<string, string>> = {
	feat: "Added",
	fix: "Fixed",
	docs: "Changed",
	ci: "Changed",
	refactor: "Changed",
	perf: "Changed",
	test: "Changed",
	chore: "Changed",
	build: "Changed",
	style: "Changed",
	revert: "Fixed",
};

const SKIP_PREFIXES: ReadonlySet<string> = new Set(["release", "ci", "test"]);

const SECTION_ORDER: readonly string[] = ["Added", "Changed", "Fixed", "Removed"];

function runGit(...args: string[]): string {
	const proc = spawnSync("git", args, { encoding: "utf-8" });
	if (proc.status !== 0) {
		process.stderr.write(
			`git ${args.join(" ")} failed: ${(proc.stderr ?? "").trim()}\n`,
		);
		process.exit(1);
	}
	return (proc.stdout ?? "").trim();
}

function getPreviousTag(): string | null {
	const output = runGit("tag", "--sort=-version:refname");
	const tags = output
		.split("\n")
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	return tags.length >= 2 ? (tags[1] ?? null) : null;
}

function getCommits(sinceTag: string | null): string[] {
	const range = sinceTag ? `${sinceTag}..HEAD` : "HEAD";
	const output = runGit("log", range, "--pretty=format:%s", "--first-parent");
	return output
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

type ClassifiedCommit = {
	readonly category: string | null;
	readonly description: string;
};

export function classifyCommit(message: string): ClassifiedCommit {
	// Strip PR reference suffix like (#25)
	const clean = message.replace(/\s*\(#\d+\)\s*$/, "");

	// Prefix match: "feat: desc" or "feat(scope): desc"
	const match = /^(\w+)(?:\([^)]*\))?\s*:\s*(.+)$/.exec(clean);
	if (match) {
		const prefix = (match[1] ?? "").toLowerCase();
		const description = (match[2] ?? "").trim();
		if (SKIP_PREFIXES.has(prefix)) return { category: null, description: "" };
		const category = PREFIX_MAP[prefix] ?? "Changed";
		return { category, description };
	}

	if (!clean) return { category: "Changed", description: clean };
	return {
		category: "Changed",
		description: clean[0]!.toUpperCase() + clean.slice(1),
	};
}

function todayUTC(): string {
	const d = new Date();
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function generateSection(version: string, commits: readonly string[]): string {
	const today = todayUTC();
	const grouped: Record<string, string[]> = {};

	for (const msg of commits) {
		const { category, description } = classifyCommit(msg);
		if (category === null) continue;
		if (!(category in grouped)) grouped[category] = [];
		grouped[category]!.push(description);
	}

	const lines: string[] = [`## ${version} — ${today}`, ""];

	for (const section of SECTION_ORDER) {
		if (section in grouped) {
			lines.push(`### ${section}`);
			for (const item of grouped[section]!) {
				lines.push(`- ${item}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prependToChangelog(section: string, version: string): void {
	const content = readFileSync("CHANGELOG.md", { encoding: "utf-8" });
	const versionPattern = new RegExp(`^## ${escapeRegex(version)} — .*$`, "m");
	const existingPattern = new RegExp(
		`^## ${escapeRegex(version)} — [\\s\\S]*?(?=\\n## [^\\n]|$)`,
		"m",
	);

	let newContent: string;
	if (versionPattern.test(content)) {
		newContent = content.replace(existingPattern, section.trimEnd());
	} else {
		const header = "# Changelog";
		const idx = content.indexOf(header);
		if (idx === -1) {
			newContent = `${header}\n\n${section}\n${content}`;
		} else {
			let insertAt = idx + header.length;
			while (
				insertAt < content.length &&
				(content[insertAt] === "\n" || content[insertAt] === "\r")
			) {
				insertAt += 1;
			}
			newContent =
				content.slice(0, insertAt) +
				"\n" +
				section +
				"\n" +
				content.slice(insertAt);
		}
	}

	writeFileSync("CHANGELOG.md", newContent, { encoding: "utf-8" });
}

export function normalizeVersion(version: string): string {
	const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version);
	if (!match) {
		process.stderr.write(
			`Invalid version '${version}'. Expected vX.Y or vX.Y.Z.\n`,
		);
		process.exit(1);
	}
	const [, major, minor, patch] = match;
	return `${major}.${minor}.${patch ?? "0"}`;
}

/**
 * Derive the fingerprint key from a release version. A `.0` patch is dropped
 * to match the existing manifest convention (e.g. "5.0.0" → "v5.0", while
 * "5.1.2" stays "v5.1.2"). Keys are prefixed with `v` for parity with git tags.
 */
export function toFingerprintKey(version: string): string {
	const normalized = normalizeVersion(version);
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(normalized);
	if (!match) return `v${normalized}`;
	const [, major, minor, patch] = match;
	return patch === "0" ? `v${major}.${minor}` : `v${major}.${minor}.${patch}`;
}

/**
 * Files added between the previous tag and HEAD, via `git diff --diff-filter=A`.
 * Returns paths relative to the repo root. An empty list signals "nothing
 * structurally new was added in this release" — callers treat it as "skip
 * fingerprint generation."
 */
function getAddedFiles(prevTag: string): string[] {
	const proc = spawnSync(
		"git",
		[
			"diff",
			`${prevTag}..HEAD`,
			"--name-only",
			"--diff-filter=A",
		],
		{ encoding: "utf-8" },
	);
	if (proc.status !== 0) return [];
	return (proc.stdout ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/**
 * Paths to skip when picking fingerprint markers, even if they're covered by
 * the manifest's infrastructure globs. These are volatile implementation
 * details — tests, internal libs, CI plumbing, vendored deps — that shouldn't
 * serve as stable version markers because they may be renamed or removed.
 */
const MARKER_SKIP_PATTERNS: readonly RegExp[] = [
	/(^|\/)tests?\//,
	/(^|\/)lib\//,
	/(^|\/)node_modules\//,
	/\.github\//,
	/\.test\.ts$/,
];

/**
 * Return the immediate parent directory of a path, or "" for root-level files.
 * Used to reason about how "alone" a file is among its siblings in the diff.
 */
function parentOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * Choose up to `limit` stable version markers from the newly-added files.
 * A marker must be (a) covered by the manifest's infrastructure globs — so
 * it's template content, not user content — and (b) not in a skip pattern.
 *
 * Among qualifying candidates we prefer more *distinctive* files: shallower
 * paths (root files and top-level directory additions tend to be feature
 * declarations rather than plumbing) and singletons in their parent
 * directory (a file added alone in its folder is a stronger signal than
 * one of 15 files added to a bulk-migrated directory). Alphabetical order
 * is the final tiebreak so the output is deterministic.
 */
export function pickMarkers(
	addedFiles: readonly string[],
	infrastructureGlobs: readonly string[],
	limit = 3,
): string[] {
	const qualified = addedFiles.filter(
		(p) =>
			isCovered(p, infrastructureGlobs) &&
			!MARKER_SKIP_PATTERNS.some((re) => re.test(p)),
	);

	// Count siblings-added-in-this-diff per parent directory. Only other
	// qualified files count — skipped/uncovered additions don't dilute the
	// signal because they wouldn't be candidates anyway.
	const siblingCount = new Map<string, number>();
	for (const p of qualified) {
		const parent = parentOf(p);
		siblingCount.set(parent, (siblingCount.get(parent) ?? 0) + 1);
	}

	const ranked = [...qualified].sort((a, b) => {
		const depthA = a.split("/").length;
		const depthB = b.split("/").length;
		if (depthA !== depthB) return depthA - depthB;
		const sibA = siblingCount.get(parentOf(a)) ?? 0;
		const sibB = siblingCount.get(parentOf(b)) ?? 0;
		if (sibA !== sibB) return sibA - sibB;
		return a.localeCompare(b);
	});

	return ranked.slice(0, limit);
}

type Fingerprint = {
	exists: string[];
	missing?: string[];
};

/**
 * Find the latest fingerprint key that has no `missing` field — conceptually
 * "the currently-open-ended release." Returns null if the map is empty or
 * every entry already has a `missing`. Keys are sorted by numeric version
 * components (v3.7 < v3.10, unlike string sort) so the "latest" is the one
 * with the highest major/minor/patch.
 */
export function findLatestOpenFingerprint(
	fingerprints: Readonly<Record<string, Fingerprint>>,
): string | null {
	const sorted = Object.keys(fingerprints).sort((a, b) => {
		const pa = a.replace(/^v/, "").split(".").map(Number);
		const pb = b.replace(/^v/, "").split(".").map(Number);
		const len = Math.max(pa.length, pb.length);
		for (let i = 0; i < len; i++) {
			const da = pa[i] ?? 0;
			const db = pb[i] ?? 0;
			if (da !== db) return da - db;
		}
		return 0;
	});
	for (let i = sorted.length - 1; i >= 0; i--) {
		const key = sorted[i]!;
		if (!fingerprints[key]!.missing) return key;
	}
	return null;
}

type ManifestShape = {
	infrastructure?: string[];
	version_fingerprints?: Record<string, Fingerprint>;
	[key: string]: unknown;
};

/**
 * Auto-generate the fingerprint entry for `version` from git history, and
 * close out the previous open-ended fingerprint so version detection stays
 * unambiguous. No-op when there's no previous tag (first release) or when
 * the release added no stable markers.
 */
function updateFingerprints(
	version: string,
	prevTag: string | null,
	manifest: ManifestShape,
): void {
	if (!prevTag) return;

	const fingerprints = manifest.version_fingerprints ?? {};
	const addedFiles = getAddedFiles(prevTag);
	const globs = manifest.infrastructure ?? [];
	const markers = pickMarkers(addedFiles, globs);

	if (markers.length === 0) {
		process.stderr.write(
			`No stable infrastructure markers added since ${prevTag}; skipping fingerprint for ${version}.\n`,
		);
		return;
	}

	const key = toFingerprintKey(version);

	// Close out the previous open-ended fingerprint BEFORE adding the new
	// one, so we don't look up the new entry as its own predecessor.
	const prevKey = findLatestOpenFingerprint(fingerprints);
	if (prevKey && prevKey !== key) {
		fingerprints[prevKey] = {
			...fingerprints[prevKey]!,
			missing: [markers[0]!],
		};
	}

	fingerprints[key] = { exists: [...markers] };
	manifest.version_fingerprints = fingerprints;
}

function updateManifest(version: string, prevTag: string | null): void {
	const content = readFileSync("vault-manifest.json", { encoding: "utf-8" });
	const manifest = JSON.parse(content) as ManifestShape;
	(manifest as Record<string, unknown>)["version"] = normalizeVersion(version);
	(manifest as Record<string, unknown>)["released"] = todayUTC();
	updateFingerprints(version, prevTag, manifest);
	writeFileSync(
		"vault-manifest.json",
		JSON.stringify(manifest, null, 2) + "\n",
		{ encoding: "utf-8" },
	);
}

function main(): void {
	const version = process.argv[2];
	if (!version) {
		process.stderr.write(
			"Usage: generate-changelog.ts <version>\n",
		);
		process.exit(1);
	}

	const prevTag = getPreviousTag();
	const commits = getCommits(prevTag);

	if (commits.length === 0) {
		process.stderr.write("No commits found since previous tag.\n");
		process.exit(1);
	}

	const section = generateSection(version, commits);

	if (!commits.some((msg) => classifyCommit(msg).category !== null)) {
		process.stderr.write(
			"All commits were skipped (ci/test/release only). Nothing to changelog.\n",
		);
		process.exit(1);
	}

	prependToChangelog(section, version);
	updateManifest(version, prevTag);

	// Print section for GitHub Release body
	process.stdout.write(section);
	if (!section.endsWith("\n")) process.stdout.write("\n");
}

// Only run main when invoked as a script (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
