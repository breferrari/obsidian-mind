#!/usr/bin/env node
/**
 * Parity harness — runs the Python and TS implementations against a shared
 * corpus and fails on any divergence. Governs the deletion gate: the Python
 * files are not deleted until every mode exits 0.
 *
 * Usage:
 *   node --experimental-strip-types .github/scripts/parity-check.ts classify
 *   node --experimental-strip-types .github/scripts/parity-check.ts validate
 *   node --experimental-strip-types .github/scripts/parity-check.ts changelog
 *   node --experimental-strip-types .github/scripts/parity-check.ts all
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO = process.cwd();
const PY = process.env["PYTHON"] ?? "python3";
const NODE = process.execPath;

type RunResult = { stdout: string; stderr: string; code: number };

function run(cmd: string, args: string[], input: string): RunResult {
	const proc: SpawnSyncReturns<string> = spawnSync(cmd, args, {
		input,
		encoding: "utf-8",
		timeout: 30_000,
	});
	return {
		stdout: proc.stdout ?? "",
		stderr: proc.stderr ?? "",
		code: proc.status ?? -1,
	};
}

type KnownImprovement = {
	readonly mode: "classify" | "validate";
	readonly input: string;
	readonly note: string;
};

function loadKnownImprovements(): KnownImprovement[] {
	const path = resolve(REPO, ".github/fixtures/known-improvements.jsonl");
	try {
		const content = readFileSync(path, { encoding: "utf-8" });
		return content
			.split("\n")
			.filter((l) => l.trim().length > 0 && !l.trim().startsWith("//"))
			.map((l) => JSON.parse(l) as KnownImprovement);
	} catch {
		return [];
	}
}

function isKnownImprovement(
	mode: "classify" | "validate",
	input: string,
	known: readonly KnownImprovement[],
): boolean {
	return known.some((k) => k.mode === mode && k.input === input);
}

// ---------------------------------------------------------------------------
// Classify parity
// ---------------------------------------------------------------------------

type ClassifyCase = { readonly prompt: string; readonly tag?: string };

function loadClassifyCorpus(): ClassifyCase[] {
	const path = resolve(REPO, ".github/fixtures/classify-corpus.jsonl");
	const content = readFileSync(path, { encoding: "utf-8" });
	return content
		.split("\n")
		.filter((l) => l.trim().length > 0 && !l.trim().startsWith("//"))
		.map((l) => JSON.parse(l) as ClassifyCase);
}

function parityClassify(): number {
	const cases = loadClassifyCorpus();
	const known = loadKnownImprovements();
	const pyScript = resolve(REPO, ".claude/scripts/classify-message.py");
	const tsScript = resolve(REPO, ".claude/scripts/classify-message.ts");

	console.log(`[classify] running ${cases.length} cases`);
	let diffs = 0;
	for (const c of cases) {
		const stdin = JSON.stringify({ prompt: c.prompt });
		const pyOut = run(PY, [pyScript], stdin);
		const tsOut = run(NODE, ["--experimental-strip-types", tsScript], stdin);

		if (pyOut.stdout !== tsOut.stdout) {
			if (isKnownImprovement("classify", c.prompt, known)) continue;
			diffs++;
			if (diffs <= 10) {
				console.error(`\n[DIVERGENCE] prompt: ${JSON.stringify(c.prompt)}`);
				console.error(`  python: ${pyOut.stdout}`);
				console.error(`      ts: ${tsOut.stdout}`);
			}
		}
	}

	if (diffs > 0) {
		console.error(`\n[classify] ${diffs} divergence(s) found. FAIL.`);
		return 1;
	}
	console.log(`[classify] all ${cases.length} cases match. OK.`);
	return 0;
}

// ---------------------------------------------------------------------------
// Validate parity
// ---------------------------------------------------------------------------

function parityValidate(): number {
	const corpusDir = resolve(REPO, ".github/fixtures/validate-corpus");
	const files = readdirSync(corpusDir).filter((f) => f.endsWith(".md"));
	const pyScript = resolve(REPO, ".claude/scripts/validate-write.py");
	const tsScript = resolve(REPO, ".claude/scripts/validate-write.ts");

	console.log(`[validate] running ${files.length} fixtures`);
	let diffs = 0;
	for (const f of files) {
		const filePath = join(corpusDir, f);
		const stdin = JSON.stringify({ tool_input: { file_path: filePath } });
		const pyOut = run(PY, [pyScript], stdin);
		const tsOut = run(NODE, ["--experimental-strip-types", tsScript], stdin);

		if (pyOut.stdout !== tsOut.stdout) {
			diffs++;
			console.error(`\n[DIVERGENCE] file: ${f}`);
			console.error(`  python: ${pyOut.stdout}`);
			console.error(`      ts: ${tsOut.stdout}`);
		}
	}

	// Also exercise the skip-rule paths (fake paths, not real files)
	const skipPaths = [
		"/vault/README.md",
		"/vault/README.ja.md",
		"/vault/CHANGELOG.md",
		"/vault/.claude/commands/foo.md",
		"/vault/templates/Work Note.md",
		"/vault/thinking/draft.md",
		"/tmp/test.txt",
		"C:\\vault\\.claude\\commands\\foo.md",
	];
	for (const p of skipPaths) {
		const stdin = JSON.stringify({ tool_input: { file_path: p } });
		const pyOut = run(PY, [pyScript], stdin);
		const tsOut = run(NODE, ["--experimental-strip-types", tsScript], stdin);
		if (pyOut.stdout !== tsOut.stdout) {
			diffs++;
			console.error(`\n[DIVERGENCE] skip-path: ${p}`);
			console.error(`  python: ${pyOut.stdout}`);
			console.error(`      ts: ${tsOut.stdout}`);
		}
	}

	// Robustness cases (malformed input)
	const robustness = [
		"not json",
		"",
		JSON.stringify({}),
		JSON.stringify({ tool_input: null }),
		JSON.stringify({ tool_input: { file_path: 123 } }),
		JSON.stringify({ tool_input: { file_path: "/nonexistent/file.md" } }),
	];
	for (const r of robustness) {
		const pyOut = run(PY, [pyScript], r);
		const tsOut = run(NODE, ["--experimental-strip-types", tsScript], r);
		if (pyOut.stdout !== tsOut.stdout) {
			diffs++;
			console.error(`\n[DIVERGENCE] robustness input: ${r.slice(0, 80)}`);
			console.error(`  python: ${pyOut.stdout}`);
			console.error(`      ts: ${tsOut.stdout}`);
		}
	}

	if (diffs > 0) {
		console.error(`\n[validate] ${diffs} divergence(s) found. FAIL.`);
		return 1;
	}
	console.log(`[validate] all fixtures + skip paths + robustness match. OK.`);
	return 0;
}

// ---------------------------------------------------------------------------
// Changelog parity
// ---------------------------------------------------------------------------
//
// Safe single-shot parity: generate-changelog.{py,ts} mutate CHANGELOG.md and
// vault-manifest.json. We capture the original bytes of just those two files,
// run each script with a sentinel version string, snapshot the mutation,
// immediately restore from captured bytes. No git operations, no time travel,
// no risk to unrelated tracked files.
//
// Previous versions of this function used `git checkout <tag>^ -- .` to
// time-travel the working tree and INDEX. That was destructive across every
// tracked file and is now explicitly forbidden. Do not reintroduce that
// approach without worktree isolation.

function parityChangelog(): number {
	const pyScript = resolve(REPO, ".github/scripts/generate-changelog.py");
	const tsScript = resolve(REPO, ".github/scripts/generate-changelog.ts");
	const changelogPath = resolve(REPO, "CHANGELOG.md");
	const manifestPath = resolve(REPO, "vault-manifest.json");

	const origChangelog = readFileSync(changelogPath, { encoding: "utf-8" });
	const origManifest = readFileSync(manifestPath, { encoding: "utf-8" });

	function restore(): void {
		writeFileSync(changelogPath, origChangelog, { encoding: "utf-8" });
		writeFileSync(manifestPath, origManifest, { encoding: "utf-8" });
	}

	const TEST_VERSION = "v99.99-parity-test";

	try {
		console.log(`[changelog] single-shot parity on ${TEST_VERSION}`);

		const pyProc = run(PY, [pyScript, TEST_VERSION], "");
		const pyChangelog = readFileSync(changelogPath, { encoding: "utf-8" });
		const pyManifest = readFileSync(manifestPath, { encoding: "utf-8" });
		restore();

		const tsProc = run(NODE, [
			"--experimental-strip-types",
			tsScript,
			TEST_VERSION,
		], "");
		const tsChangelog = readFileSync(changelogPath, { encoding: "utf-8" });
		const tsManifest = readFileSync(manifestPath, { encoding: "utf-8" });
		restore();

		let diffs = 0;
		if (pyProc.stdout !== tsProc.stdout) {
			diffs++;
			console.error("\n[DIVERGENCE] stdout");
			console.error(`  python:\n${pyProc.stdout}`);
			console.error(`      ts:\n${tsProc.stdout}`);
		}
		if (pyChangelog !== tsChangelog) {
			diffs++;
			console.error("\n[DIVERGENCE] CHANGELOG.md mutation");
		}
		if (pyManifest !== tsManifest) {
			diffs++;
			console.error("\n[DIVERGENCE] vault-manifest.json mutation");
		}

		if (diffs > 0) {
			console.error(`\n[changelog] ${diffs} divergence(s). FAIL.`);
			return 1;
		}
		console.log(`[changelog] stdout + CHANGELOG.md + vault-manifest.json match. OK.`);
		return 0;
	} finally {
		// Belt-and-suspenders: if anything threw between mutation and restore,
		// we still write the original bytes back.
		restore();
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
	const mode = process.argv[2];
	if (!mode) {
		console.error(
			"Usage: parity-check.ts <classify|validate|changelog|all> [--tags N]",
		);
		return 1;
	}

	if (mode === "classify") return parityClassify();
	if (mode === "validate") return parityValidate();
	if (mode === "changelog") {
		return parityChangelog();
	}
	if (mode === "all") {
		const c = parityClassify();
		const v = parityValidate();
		const cl = parityChangelog();
		return c || v || cl;
	}
	console.error(`Unknown mode: ${mode}`);
	return 1;
}

process.exit(main());
