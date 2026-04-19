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
import { isValidQmdIndex } from "../.claude/scripts/lib/session-start.ts";

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

type SpawnOutcome = {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * Run qmd and capture both streams so callers can classify failures.
 * Captured output is echoed to the user afterward so the visible log matches
 * `stdio: "inherit"` ordering.
 */
function spawnQmd(
	entry: string | null,
	subcommandArgs: readonly string[],
): SpawnOutcome {
	const { cmd, args, shell } = buildQmdCommand(entry, subcommandArgs);
	const r = spawnSync(cmd, args as string[], { shell, encoding: "utf-8" });
	return {
		status: r.status,
		signal: r.signal,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
}

function echo(outcome: SpawnOutcome): void {
	if (outcome.stdout) process.stdout.write(outcome.stdout);
	if (outcome.stderr) process.stderr.write(outcome.stderr);
}

function ensureQmd(entry: string | null): void {
	const probe = spawnQmd(entry, ["--version"]);
	if (probe.status !== 0) {
		process.stderr.write(
			"qmd not found. Install it first: npm i -g @tobilu/qmd\n",
		);
		process.exit(1);
	}
}

/**
 * Run a qmd subcommand and treat any non-zero exit as fatal. Echoes captured
 * stdout/stderr before exiting so the user sees qmd's own diagnostic.
 */
function run(
	entry: string | null,
	args: readonly string[],
	description: string,
): void {
	process.stdout.write(`→ ${description}\n`);
	const outcome = spawnQmd(entry, args);
	echo(outcome);
	if (outcome.status !== 0) {
		process.stderr.write(
			`qmd exited with code ${outcome.status ?? "?"} during: ${description}\n`,
		);
		process.exit(outcome.status ?? 1);
	}
}

/**
 * Run a qmd subcommand that is *expected* to fail idempotently (e.g. removing
 * a context entry that may not exist). Callers pass a predicate that inspects
 * the captured stderr/stdout and returns true when the failure matches the
 * known-benign case; any other failure is surfaced as a prominent warning so
 * it isn't silently masked.
 *
 * This replaces a plain "ignore all failures" helper that would swallow real
 * problems (invalid pattern, permissions, qmd install drift) alongside the
 * benign ones.
 */
function runIdempotent(
	entry: string | null,
	args: readonly string[],
	description: string,
	isBenignFailure: (outcome: SpawnOutcome) => boolean,
): void {
	process.stdout.write(`→ ${description}\n`);
	const outcome = spawnQmd(entry, args);
	echo(outcome);
	if (outcome.status !== 0 && !isBenignFailure(outcome)) {
		process.stderr.write(
			`\n⚠ qmd exited with code ${outcome.status ?? "?"} during: ${description}\n` +
				`  This wasn't the expected idempotent failure. Continuing, but review the output above.\n\n`,
		);
	}
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
	if (!isValidQmdIndex(index)) {
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

	// `collection add` fails with a specific message when the collection is
	// already registered — that's the idempotent case we expect on re-run.
	// Any other failure (invalid pattern, permissions, qmd install drift) is
	// surfaced as a warning so it isn't silently masked.
	runIdempotent(
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
		(o) => /already exists/i.test(o.stderr) || /already exists/i.test(o.stdout),
	);

	// Re-attach the context string so edits to vault-manifest.json propagate.
	// On first run, `context rm` fails because the row doesn't exist — that's
	// the expected benign case. Unexpected failures (auth, IO) get warned.
	runIdempotent(
		entry,
		["--index", index, "context", "rm", contextPath],
		"Clearing previous context (if any)",
		(o) =>
			/not found/i.test(o.stderr) ||
			/not found/i.test(o.stdout) ||
			/does not exist/i.test(o.stderr) ||
			/does not exist/i.test(o.stdout),
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
