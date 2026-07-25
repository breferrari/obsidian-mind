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
 *   3. Sync `.obsidian/app.json` userIgnoreFilters into the QMD YAML config
 *      so both engines hide the same files from search.
 *   4. Walk the vault and build the sparse index.
 *   5. Generate vector embeddings.
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
 *   node --experimental-strip-types .scripts/qmd-bootstrap.ts
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { warn } from "../.claude/scripts/lib/hook-io.ts";
import { isMainModule } from "../.claude/scripts/lib/main-guard.ts";
import {
	buildCollectionAddArgs,
	isContextRemoveBenign,
	isUnknownSubcommandFailure,
	legacyCollectionCandidate,
	makeCollectionAddBenignMatcher,
} from "../.claude/scripts/lib/qmd-bootstrap.ts";
import {
	buildQmdCommand,
	qmdVersionAtLeast,
	resolveQmdEntry,
} from "../.claude/scripts/lib/qmd.ts";
import {
	qmdConfigPath,
	readObsidianIgnore,
	translateToGlob,
	writeQmdIgnore,
} from "../.claude/scripts/lib/qmd-ignore.ts";
import {
	deriveQmdIndex,
	isValidQmdIndex,
	resolveQmdIndex,
} from "../.claude/scripts/lib/session-start.ts";

type ManifestSubset = {
	readonly qmd_index?: string;
	readonly qmd_context?: string;
	readonly qmd_min_version?: string;
	readonly template?: string;
};

function readManifestRaw(): string | null {
	try {
		return readFileSync("vault-manifest.json", { encoding: "utf-8" });
	} catch {
		return null; /* handled by caller */
	}
}

function parseManifest(raw: string | null): ManifestSubset | null {
	if (raw === null) return null;
	try {
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

/** Verify qmd is installed; returns the raw `--version` output for the
 *  min-version gate in main(). */
function ensureQmd(entry: string | null): string {
	const probe = spawnQmd(entry, ["--version"]);
	if (probe.status !== 0) {
		process.stderr.write(
			"qmd not found. Install it first: npm i -g @tobilu/qmd\n",
		);
		process.exit(1);
	}
	return probe.stdout;
}

/**
 * Quiet existence probe — no echo, because "not found" here is an expected
 * state during migration checks, not a diagnostic the user needs to see.
 */
function collectionExists(
	entry: string | null,
	index: string,
	name: string,
): boolean {
	return (
		spawnQmd(entry, ["--index", index, "collection", "show", name]).status === 0
	);
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
	const manifestRaw = readManifestRaw();
	const manifest = parseManifest(manifestRaw);
	if (!manifest) {
		process.stderr.write(
			"vault-manifest.json missing or unreadable. Run from the vault root.\n",
		);
		process.exit(1);
	}

	// A non-empty `qmd_index` is an explicit pin and is taken literally — a
	// typo there must fail loudly rather than silently fall through to a
	// derived name, or the vault quietly indexes somewhere the user didn't ask
	// for. Only an absent/empty field opts into derivation (#137).
	const pinned = manifest.qmd_index;
	if (pinned !== undefined && pinned !== "" && !isValidQmdIndex(pinned)) {
		process.stderr.write(
			`vault-manifest.json \`qmd_index\` value ${JSON.stringify(pinned)} is not a valid index name.\n` +
				"Allowed: alphanumerics, dot, dash, underscore; must start with an alphanumeric.\n" +
				"(The value is used both in CLI argv and a filesystem path, so path separators and whitespace aren't accepted.)\n",
		);
		process.exit(1);
	}

	// Route through the SAME resolver the read surfaces use rather than
	// reimplementing the precedence here. This script WRITES the store; a
	// private fallback would populate one index while SessionStart, the
	// refresh worker, and the MCP wrapper read another — which surfaces as
	// "0 documents", not as an error.
	// `process.cwd()` is the vault root: `readManifest()` above already
	// resolved `vault-manifest.json` relative to it, so a wrong cwd has
	// already failed.
	const index = resolveQmdIndex(manifestRaw, process.cwd());

	if (index === null) {
		process.stderr.write(
			"Could not determine a qmd index name for this vault.\n" +
				"The vault folder name yields no usable slug and the manifest has no " +
				"`template` to fall back on.\n" +
				'Set one explicitly: "qmd_index": "my-vault" in vault-manifest.json.\n',
		);
		process.exit(1);
	}

	// Reaching the `template` fallback means this vault shares a store with
	// every other install that did the same — the exact collision #137 fixes.
	// Keyed on derivation FAILING, not on the resolved name matching
	// `template`: a vault whose folder legitimately slugifies to the template
	// name is correctly isolated and must not be warned at.
	if (!isValidQmdIndex(pinned) && deriveQmdIndex(process.cwd()) === null) {
		warn(
			`Vault folder name yields no usable index slug — falling back to the shared '${index}' index. ` +
				'Set "qmd_index" in vault-manifest.json to keep this vault\'s search store isolated.',
		);
	}

	// Resolve once up front so every downstream spawn reuses the same entry.
	const entry = resolveQmdEntry();

	const versionOut = ensureQmd(entry);

	// Min-version gate (#100): a silently-old qmd is the failure the version
	// declaration exists to catch — fail loud here, where the user is already
	// taking explicit setup action. Fails OPEN on unparseable versions (an
	// unknown version must never brick the bootstrap); vaults without the
	// manifest field skip the gate entirely.
	const minVersion = manifest.qmd_min_version;
	if (
		typeof minVersion === "string" &&
		!qmdVersionAtLeast(versionOut, minVersion)
	) {
		process.stderr.write(
			`Installed qmd (${versionOut.trim()}) is below this vault's declared minimum (${minVersion}).\n` +
				"Update it: npm i -g @tobilu/qmd\n",
		);
		process.exit(1);
	}

	// Collection name = qmd_index, the per-vault identity (#105). `template`
	// is the shared package identity — the same string for every install —
	// so deriving the collection name from it breaks idempotency on any
	// vault where the two differ (and mismatches the on-disk collection,
	// which qmd creates under the vault's own name). qmd_index was validated
	// above, so no second validation branch is needed.
	const collectionName = index;
	const contextPath = `qmd://${collectionName}/`;
	const contextText =
		manifest.qmd_context ??
		"Obsidian vault template with persistent AI agent memory.";

	process.stdout.write(`→ Bootstrapping QMD index '${index}'\n`);

	// Migration (#105): bootstraps before the fix registered the collection
	// under the shared `template` name. Field states to handle:
	//   1. No legacy collection (fresh install, or the old bootstrap failed
	//      before registering) → nothing to do.
	//   2. Legacy exists, correctly-named one doesn't → RENAME in place.
	//      Rename keeps the indexed data, so migrated users pay no re-index.
	//   3. Both exist (user already re-registered by hand) → REMOVE the
	//      legacy one; two collections over the same corpus double every
	//      search result.
	// `collection rename` may not exist on older qmd installs — fall back to
	// remove, and the `collection add` below registers the correct name fresh.
	const legacyName = legacyCollectionCandidate(manifest.template, index);
	if (legacyName !== null && collectionExists(entry, index, legacyName)) {
		if (collectionExists(entry, index, collectionName)) {
			run(
				entry,
				["--index", index, "collection", "remove", legacyName],
				`Removing legacy collection '${legacyName}' (superseded by '${collectionName}')`,
			);
		} else {
			process.stdout.write(
				`→ Renaming legacy collection '${legacyName}' → '${collectionName}' (#105 migration)\n`,
			);
			const renamed = spawnQmd(entry, [
				"--index",
				index,
				"collection",
				"rename",
				legacyName,
				collectionName,
			]);
			echo(renamed);
			// qmd exits 0 even for unknown subcommands, so rename success is
			// verified by probing the target collection — never by exit status.
			if (!collectionExists(entry, index, collectionName)) {
				if (isUnknownSubcommandFailure(renamed)) {
					// Older qmd without `collection rename`: remove the legacy
					// entry; the registration below re-adds under the correct
					// name and the update/embed steps rebuild its index rows.
					run(
						entry,
						["--index", index, "collection", "remove", legacyName],
						`Rename unavailable — removing legacy collection '${legacyName}' instead`,
					);
				} else {
					// Unexpected failure (locked store, CLI drift): do NOT
					// destroy the legacy collection — leave it for inspection.
					// The registration below surfaces the conflict loudly.
					warn(
						`Could not rename legacy collection '${legacyName}' — leaving it in place. ` +
							`Migrate manually: qmd --index ${index} collection rename ${legacyName} ${collectionName}`,
					);
				}
			}
		}
		// The legacy context row is keyed by the legacy path — clear it so a
		// stale summary doesn't shadow the one attached below.
		runIdempotent(
			entry,
			["--index", index, "context", "rm", `qmd://${legacyName}/`],
			"Clearing legacy context (if any)",
			isContextRemoveBenign,
		);
	}

	// Re-runs are idempotent (matcher recognises the by-name "already exists"
	// case); a path-collision warning is intentionally NOT swallowed.
	runIdempotent(
		entry,
		buildCollectionAddArgs(index, collectionName),
		`Registering collection '${collectionName}' (mask **/*.md)`,
		makeCollectionAddBenignMatcher(collectionName),
	);

	// Round-trip the registration: if a future qmd CLI change silently breaks
	// our argv shape, this is where we find out — `collection show` exits 1
	// with "Collection not found: <name>" rather than running past the issue.
	run(
		entry,
		["--index", index, "collection", "show", collectionName],
		`Verifying collection '${collectionName}' is registered`,
	);

	// Re-attach the context string so edits to vault-manifest.json propagate.
	// On first run, `context rm` fails because the row doesn't exist — that's
	// the expected benign case. Any other failure (including a genuine
	// "Collection not found") is intentionally NOT swallowed.
	runIdempotent(
		entry,
		["--index", index, "context", "rm", contextPath],
		"Clearing previous context (if any)",
		isContextRemoveBenign,
	);
	run(
		entry,
		["--index", index, "context", "add", contextPath, contextText],
		"Attaching vault context from manifest",
	);

	// Propagate Obsidian's userIgnoreFilters into QMD's YAML so both engines
	// honor the same hidden-file list. Runs after `collection add` because
	// that call overwrites the collection entry without preserving `ignore`.
	// readObsidianIgnore returns null when app.json is unreadable/unparseable —
	// we skip propagation in that case so a user typo doesn't strip the
	// existing QMD ignore block. A warn() has already been emitted.
	const obsidianIgnore = readObsidianIgnore();
	if (obsidianIgnore !== null) {
		const qmdIgnore: string[] = [];
		for (const p of obsidianIgnore) {
			const glob = translateToGlob(p);
			if (glob === null) {
				warn(
					`Skipping regex pattern ${JSON.stringify(p)} — QMD ignore field accepts globs only.`,
				);
				continue;
			}
			qmdIgnore.push(glob);
		}
		// Print the step header only after the write succeeds, so logs never
		// show "→ Syncing..." as a completed step when writeQmdIgnore actually
		// skipped (missing config or unknown collection — both already warn()).
		const wrote = writeQmdIgnore(
			qmdConfigPath(index),
			collectionName,
			qmdIgnore,
		);
		if (wrote) {
			process.stdout.write(
				"→ Syncing ignore patterns from .obsidian/app.json\n",
			);
			if (qmdIgnore.length > 0) {
				process.stdout.write(
					`  ${qmdIgnore.length} ignore pattern(s) synced from .obsidian/app.json\n`,
				);
			}
		}
	}

	run(entry, ["--index", index, "update"], "Indexing vault files");
	run(entry, ["--index", index, "embed"], "Generating embeddings");

	process.stdout.write(
		`\n✓ QMD index '${index}' ready. Test with:\n  qmd --index ${index} query "<topic>"\n`,
	);
}

if (isMainModule(import.meta.url)) main();
