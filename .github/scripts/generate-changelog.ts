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
import { readFileSync, writeFileSync } from "node:fs";

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

function updateManifest(version: string): void {
	const content = readFileSync("vault-manifest.json", { encoding: "utf-8" });
	const manifest = JSON.parse(content) as Record<string, unknown>;
	manifest["version"] = normalizeVersion(version);
	manifest["released"] = todayUTC();
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
	updateManifest(version);

	// Print section for GitHub Release body
	process.stdout.write(section);
	if (!section.endsWith("\n")) process.stdout.write("\n");
}

// Only run main when invoked as a script (not when imported by parity harness)
if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
