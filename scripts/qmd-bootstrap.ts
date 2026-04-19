#!/usr/bin/env node
/**
 * qmd-bootstrap.ts — idempotent QMD setup for this vault.
 *
 * Run once on a fresh clone (new machine, wiped cache, rebuilt index) to:
 *
 *   1. Register this vault as a QMD collection under the named index declared
 *      in vault-manifest.json (`qmd_index`).
 *   2. Attach the vault's context string (`qmd_context`) so QMD's snippets
 *      and rerank step know what this collection is.
 *   3. Walk the vault and build the sparse index.
 *   4. Generate vector embeddings.
 *
 * Safe to re-run. Every step reports current state rather than failing on
 * "already exists" — the context string is re-attached so updates to
 * vault-manifest.json propagate. The SQLite store itself lives in
 * ~/.cache/qmd/<index>.sqlite (derived data, not version-controlled), which
 * is why this script is the portable instruction set for regenerating it.
 *
 * Cross-platform: every spawn routes through `buildQmdCommand`, which resolves
 * @tobilu/qmd's real JS entry and runs it with the current Node binary. No
 * platform conditionals — the same command path executes on Windows, macOS,
 * and Linux.
 *
 * Usage:
 *   node --experimental-strip-types scripts/qmd-bootstrap.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { buildQmdCommand, resolveQmdEntry } from "../.claude/scripts/lib/qmd.ts";

type ManifestSubset = {
	readonly qmd_index?: string;
	readonly qmd_context?: string;
	readonly template?: string;
};

/**
 * Same validation rule as `.claude/scripts/lib/session-start.ts:QMD_INDEX_PATTERN`.
 * Rejects path separators, whitespace, empty, and parent-dir refs before the
 * name hits argv or a filesystem path.
 */
const QMD_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readManifest(): ManifestSubset | null {
	try {
		const raw = readFileSync("vault-manifest.json", { encoding: "utf-8" });
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			return parsed as ManifestSubset;
		}
	} catch {
		/* handled by caller */
	}
	return null;
}

function spawnQmd(
	entry: string | null,
	subcommandArgs: readonly string[],
	inherit: boolean,
): { readonly status: number | null; readonly signal: NodeJS.Signals | null } {
	const { cmd, args, shell } = buildQmdCommand(entry, subcommandArgs);
	const r = spawnSync(cmd, args as string[], {
		stdio: inherit ? "inherit" : "ignore",
		shell,
	});
	return { status: r.status, signal: r.signal };
}

function ensureQmd(entry: string | null): void {
	const probe = spawnQmd(entry, ["--version"], false);
	if (probe.status !== 0) {
		process.stderr.write(
			"qmd not found. Install it first: npm i -g @tobilu/qmd\n",
		);
		process.exit(1);
	}
}

function run(
	entry: string | null,
	args: readonly string[],
	description: string,
): void {
	process.stdout.write(`→ ${description}\n`);
	const r = spawnQmd(entry, args, true);
	if (r.status !== 0) {
		process.stderr.write(
			`qmd exited with code ${r.status ?? "?"} during: ${description}\n`,
		);
		process.exit(r.status ?? 1);
	}
}

function runAllowingFailure(
	entry: string | null,
	args: readonly string[],
	description: string,
): void {
	process.stdout.write(`→ ${description}\n`);
	spawnQmd(entry, args, true);
}

function main(): void {
	const manifest = readManifest();
	if (!manifest) {
		process.stderr.write(
			"vault-manifest.json missing or unreadable. Run from the vault root.\n",
		);
		process.exit(1);
	}

	const index = manifest.qmd_index;
	if (!index) {
		process.stderr.write(
			"vault-manifest.json has no `qmd_index` field. Add one before running the bootstrap.\n",
		);
		process.exit(1);
	}
	if (!QMD_INDEX_PATTERN.test(index)) {
		process.stderr.write(
			`vault-manifest.json \`qmd_index\` value ${JSON.stringify(index)} is not a valid index name.\n` +
				"Allowed: alphanumerics, dot, dash, underscore; must start with an alphanumeric.\n" +
				"(The value is used both in CLI argv and a filesystem path, so path separators and whitespace aren't accepted.)\n",
		);
		process.exit(1);
	}

	// Resolve once up front so every downstream spawn reuses the same entry.
	const entry = resolveQmdEntry();

	ensureQmd(entry);

	const collectionName = manifest.template ?? index;
	const contextPath = `qmd://${collectionName}/`;
	const contextText =
		manifest.qmd_context ??
		"Obsidian vault template with persistent AI agent memory.";

	process.stdout.write(`→ Bootstrapping QMD index '${index}'\n`);

	// `collection add` reports "already exists" on re-run — intended.
	runAllowingFailure(
		entry,
		[
			"--index",
			index,
			"collection",
			"add",
			".",
			collectionName,
			"--pattern",
			"**/*.md",
		],
		`Registering collection '${collectionName}' (pattern **/*.md)`,
	);

	// Re-attach the context string so edits to vault-manifest.json propagate.
	// Remove-then-add is safe; remove failure is ignored when nothing is there.
	runAllowingFailure(
		entry,
		["--index", index, "context", "rm", contextPath],
		"Clearing previous context (if any)",
	);
	run(
		entry,
		["--index", index, "context", "add", contextPath, contextText],
		"Attaching vault context from manifest",
	);

	run(entry, ["--index", index, "update"], "Indexing vault files");
	run(entry, ["--index", index, "embed"], "Generating embeddings");

	process.stdout.write(
		`\n✓ QMD index '${index}' ready. Test with:\n  qmd --index ${index} query "<topic>"\n`,
	);
}

main();
