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
 * Usage:
 *   node --experimental-strip-types scripts/qmd-bootstrap.ts
 *
 * Or, once QMD is on PATH, users can invoke the bundled `qmd` commands
 * directly — this script just encodes the canonical ordering.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

type ManifestSubset = {
	readonly qmd_index?: string;
	readonly qmd_context?: string;
	readonly template?: string;
};

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

function ensureQmd(): void {
	const probe = spawnSync("qmd", ["--version"], { stdio: "ignore" });
	if (probe.status !== 0) {
		process.stderr.write(
			"qmd not found on PATH. Install it first: npm i -g @tobilu/qmd\n",
		);
		process.exit(1);
	}
}

function run(args: readonly string[], description: string): void {
	process.stdout.write(`→ ${description}\n`);
	const r = spawnSync("qmd", args as string[], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (r.status !== 0) {
		process.stderr.write(
			`qmd exited with code ${r.status ?? "?"} during: ${description}\n`,
		);
		process.exit(r.status ?? 1);
	}
}

function runAllowingFailure(
	args: readonly string[],
	description: string,
): void {
	process.stdout.write(`→ ${description}\n`);
	spawnSync("qmd", args as string[], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
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

	ensureQmd();

	const collectionName = manifest.template ?? index;
	const contextPath = `qmd://${collectionName}/`;
	const contextText =
		manifest.qmd_context ??
		"Obsidian vault template with persistent AI agent memory.";

	process.stdout.write(`→ Bootstrapping QMD index '${index}'\n`);

	// `collection add` reports "already exists" on re-run — intended.
	runAllowingFailure(
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
		["--index", index, "context", "rm", contextPath],
		"Clearing previous context (if any)",
	);
	run(
		["--index", index, "context", "add", contextPath, contextText],
		"Attaching vault context from manifest",
	);

	run(["--index", index, "update"], "Indexing vault files");
	run(["--index", index, "embed"], "Generating embeddings");

	process.stdout.write(
		`\n✓ QMD index '${index}' ready. Test with:\n  qmd --index ${index} query "<topic>"\n`,
	);
}

main();
