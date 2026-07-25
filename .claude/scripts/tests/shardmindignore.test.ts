/**
 * `.shardmindignore` contract: never ship a test that cannot possibly run.
 *
 * A test file may legitimately import repo-only machinery — `.github/scripts/`
 * (repo CI) and `.shardmind/hooks/` (install-time, not vault content) are both
 * exercised that way, and repo CI needs those tests. But both directories are
 * **Tier 1** exclusions in the ShardMind engine: engine-enforced, source-side,
 * and explicitly not toggleable by a shard author. So the import target can
 * never exist in an installed vault.
 *
 * Because those imports are top-level, the consequence is not one failing
 * assertion — the module fails to load and the whole file errors out with
 * ERR_MODULE_NOT_FOUND. Four such tests shipped in v7.0.1, which is why a
 * clean install's first `npm test` failed on four missing modules (#150).
 *
 * The rule this pins: a test that reaches across a Tier 1 boundary must be
 * listed in `.shardmindignore`. Keeping it as a test rather than four static
 * lines means the *next* test written against a repo-only script fails CI here
 * instead of silently reaching a user's vault.
 *
 * Zero-dep by design, matching `shard-contract.test.ts` — the hook runtime has
 * no dependencies, so the small gitignore-glob subset needed is implemented
 * inline and unit-tested below rather than pulled from `ignore`.
 *
 * In an installed vault this passes vacuously (the offending files aren't
 * there, and neither is `.github/`), which is exactly the state it defends.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, "../../..");

/**
 * Mirrors ShardMind's `source/core/tier1.ts`. The engine is not a dependency
 * of this template, so there is nothing to import — the constant is duplicated
 * deliberately. Known limitation: if the engine *adds* a Tier 1 directory, this
 * list goes stale and the check narrows rather than breaking loudly. That fails
 * safe (a missed crossing, not a false alarm) and matches how the spec has
 * behaved since the three-tier model landed.
 */
const TIER1_EXCLUDED_DIRS = [".shardmind", ".git", ".github"] as const;

/** Matches `from "x"`, `import "x"`, and dynamic `import("x")`. */
const IMPORT_SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

function toPosix(p: string): string {
	return p.split("\\").join("/");
}

function readIgnorePatterns(): string[] {
	let source: string;
	try {
		source = readFileSync(resolve(repoRoot, ".shardmindignore"), "utf-8");
	} catch {
		return []; // absent → nothing is excluded
	}
	return source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * The gitignore glob subset `.shardmindignore` actually uses: `*` (within a
 * path segment), `**` (across segments), and `?`. Negation is rejected by the
 * engine in v0.1, so it is not handled here either.
 */
function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			continue;
		}
		out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

function ignores(patterns: readonly string[], relPosixPath: string): boolean {
	return patterns.some((raw) => {
		const pattern = raw.startsWith("/") ? raw.slice(1) : raw;
		// Trailing slash → directory pattern, matches everything beneath it.
		if (pattern.endsWith("/")) return relPosixPath.startsWith(pattern);
		const rx = globToRegExp(pattern);
		// A pattern containing a slash is anchored to the shard root; one
		// without matches a basename at any depth (gitignore semantics).
		if (pattern.includes("/")) return rx.test(relPosixPath);
		return relPosixPath.split("/").some((segment) => rx.test(segment));
	});
}

function crossesTier1(relPosixPath: string): boolean {
	const lower = relPosixPath.toLowerCase();
	return TIER1_EXCLUDED_DIRS.some(
		(dir) => lower === dir || lower.startsWith(`${dir}/`),
	);
}

function tier1ImportsOf(filePath: string): string[] {
	const source = readFileSync(filePath, "utf-8");
	const crossings = new Set<string>();
	for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
		const specifier = match[1];
		if (specifier === undefined || !specifier.startsWith(".")) continue;
		const target = toPosix(relative(repoRoot, resolve(dirname(filePath), specifier)));
		if (crossesTier1(target)) crossings.add(target);
	}
	return [...crossings];
}

describe(".shardmindignore contract", () => {
	test("tests importing repo-only machinery are excluded from installs", () => {
		const patterns = readIgnorePatterns();
		const offenders: string[] = [];

		for (const name of readdirSync(testsDir)) {
			if (!name.endsWith(".test.ts")) continue;
			const filePath = resolve(testsDir, name);
			const crossings = tier1ImportsOf(filePath);
			if (crossings.length === 0) continue;

			const relTestPath = toPosix(relative(repoRoot, filePath));
			if (ignores(patterns, relTestPath)) continue;
			offenders.push(`${relTestPath} -> ${crossings.join(", ")}`);
		}

		assert.deepEqual(
			offenders,
			[],
			"These tests import a path the engine always excludes from an install, " +
				"so the module can never resolve in a user's vault and the file fails " +
				"to load. Add each one to .shardmindignore (keep the file in the repo — " +
				"CI still needs it):\n  " +
				offenders.join("\n  "),
		);
	});
});

describe(".shardmindignore glob matching", () => {
	test("matches an exact anchored path", () => {
		assert.equal(ignores(["a/b/c.test.ts"], "a/b/c.test.ts"), true);
		assert.equal(ignores(["a/b/c.test.ts"], "a/b/d.test.ts"), false);
	});

	test("`*` stays within one path segment", () => {
		assert.equal(ignores(["a/*.md"], "a/b.md"), true);
		assert.equal(ignores(["a/*.md"], "a/b/c.md"), false);
	});

	test("`**` crosses path segments", () => {
		assert.equal(ignores(["a/**/c.md"], "a/b/c.md"), true);
	});

	test("a slashless pattern matches a basename at any depth", () => {
		assert.equal(ignores(["CONTRIBUTING.md"], "CONTRIBUTING.md"), true);
		assert.equal(ignores(["README.*.md"], "docs/README.ja.md"), true);
		assert.equal(ignores(["README.*.md"], "README.md"), false);
	});

	test("a trailing slash matches everything beneath the directory", () => {
		assert.equal(ignores([".github/"], ".github/scripts/x.ts"), true);
		assert.equal(ignores([".github/"], ".githubbed/x.ts"), false);
	});

	test("dots are literal, not regex wildcards", () => {
		assert.equal(ignores(["a.md"], "axmd"), false);
	});

	test("no patterns means nothing is excluded", () => {
		assert.equal(ignores([], "anything.md"), false);
	});
});
