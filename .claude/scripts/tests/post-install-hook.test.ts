/**
 * Unit tests for the v6 post-install hook (.shardmind/hooks/post-install.ts).
 *
 * Drives the named exports against synthetic vaults under a per-test temp
 * directory. Covers Invariant 2's binding contract: with values at defaults
 * the hook must leave `brain/North Star.md` byte-identical; with a non-empty
 * `user_name` the hook personalizes the heading once and is idempotent on
 * subsequent runs. The default-export path (which spawns `git`/`node`) isn't
 * exercised here — those subprocesses get integration coverage through
 * ShardMind's contract suite when it runs against this shard.
 *
 * Each test gets its own `os.tmpdir() + crypto.randomUUID()` directory to
 * avoid the parallel-load flake pattern documented in the take-next skill.
 * `beforeEach` / `afterEach` own the lifecycle so test bodies stay focused
 * on assertions.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import postInstall, {
	ensureGitRepo,
	personalizeNorthStar,
} from "../../../.shardmind/hooks/post-install.ts";

const NORTH_STAR_BASE = `---
date:
description: "Living document of goals, focus areas, and aspirations"
tags:
  - brain
---

# North Star

Body content that must survive personalization byte-for-byte.

## Current Focus

-

## Goals

-
`;

async function makeTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `${prefix}-${randomUUID()}-`));
}

const isENOENT = (err: unknown): boolean =>
	(err as NodeJS.ErrnoException).code === "ENOENT";

describe("personalizeNorthStar", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await makeTempDir("post-install-hook");
		await mkdir(join(vault, "brain"), { recursive: true });
		await writeFile(join(vault, "brain", "North Star.md"), NORTH_STAR_BASE, "utf-8");
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	test("personalizes the heading with the supplied name", async () => {
		await personalizeNorthStar(vault, "Jane Engineer");
		const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.match(after, /^# North Star — Jane Engineer$/m);
		assert.equal(after.includes("# North Star\n"), false, "verbatim heading must be replaced");
	});

	test("preserves the rest of the file byte-for-byte", async () => {
		await personalizeNorthStar(vault, "Jane Engineer");
		const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		// Replace the personalized line back to the verbatim form and the
		// rest of the file must equal the input exactly. Pins that the hook
		// doesn't drop frontmatter, body content, trailing newline, or
		// otherwise reflow the file.
		const restored = after.replace(/^# North Star — Jane Engineer$/m, "# North Star");
		assert.equal(restored, NORTH_STAR_BASE);
	});

	test("is idempotent — second run produces byte-identical content", async () => {
		await personalizeNorthStar(vault, "Jane Engineer");
		const afterFirst = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		await personalizeNorthStar(vault, "Jane Engineer");
		const afterSecond = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.equal(afterSecond, afterFirst);
	});

	test("idempotent against a different name once personalized", async () => {
		// Once personalized with name A, a later run with name B is a no-op.
		// Subsequent installs with a changed `user_name` value would have to
		// flow through `shardmind update`'s merge engine — the hook itself
		// never re-personalizes a file that's already been personalized.
		// Pins the anchor on `^# North Star$` (verbatim only).
		await personalizeNorthStar(vault, "Jane Engineer");
		const afterFirst = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		await personalizeNorthStar(vault, "Different Person");
		const afterSecond = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.equal(afterSecond, afterFirst);
		assert.match(afterSecond, /^# North Star — Jane Engineer$/m);
	});
});

describe("personalizeNorthStar — ENOENT tolerance", () => {
	let vault: string;

	beforeEach(async () => {
		// brain/ exists but North Star.md doesn't — covers the case where
		// `brain` deselection (impossible today since `removable: false`,
		// but the guard costs nothing) or an upstream rename leaves the
		// path absent.
		vault = await makeTempDir("post-install-hook");
		await mkdir(join(vault, "brain"), { recursive: true });
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	test("missing North Star is a no-op (no throw, no side-effect)", async () => {
		await personalizeNorthStar(vault, "Jane Engineer");
		// Match the typed errno code rather than the message string —
		// message format varies by Node version and OS, code is stable.
		await assert.rejects(
			readFile(join(vault, "brain", "North Star.md"), "utf-8"),
			isENOENT,
		);
	});
});

describe("ensureGitRepo", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await makeTempDir("post-install-hook");
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	test("skips when .git/ already exists", async () => {
		await mkdir(join(vault, ".git"), { recursive: true });
		// HEAD is one of the few files git always writes during init; if
		// the hook's skip-branch fires correctly, our pre-existing empty
		// .git/ stays empty.
		await ensureGitRepo(vault);
		await assert.rejects(
			readFile(join(vault, ".git", "HEAD"), "utf-8"),
			isENOENT,
			"ensureGitRepo must not run `git init` when .git/ already exists",
		);
	});
});

describe("postInstall (default export) — Invariant 2 binding", () => {
	// Drives the orchestration gate `if (!ctx.valuesAreDefaults)` in the
	// default export, which the named-export tests can't reach. Pre-creates
	// `.git/` to short-circuit `ensureGitRepo` (avoiding a real `git init`
	// subprocess on each test) and pins `qmd_enabled: false` so
	// `bootstrapQmd` is gated off — leaving the personalization branch as
	// the only orchestration path the test exercises.
	let vault: string;

	beforeEach(async () => {
		vault = await makeTempDir("post-install-hook");
		await mkdir(join(vault, ".git"), { recursive: true });
		await mkdir(join(vault, "brain"), { recursive: true });
		await writeFile(join(vault, "brain", "North Star.md"), NORTH_STAR_BASE, "utf-8");
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	function makeCtx(overrides: Partial<{
		valuesAreDefaults: boolean;
		userName: string;
		qmdEnabled: boolean;
	}>): {
		vaultRoot: string;
		values: Record<string, unknown>;
		modules: Record<string, "included" | "excluded">;
		shard: { name: string; version: string };
		valuesAreDefaults: boolean;
		newFiles: string[];
		removedFiles: string[];
	} {
		return {
			vaultRoot: vault,
			values: {
				user_name: overrides.userName ?? "",
				org_name: "Independent",
				vault_purpose: "engineering",
				qmd_enabled: overrides.qmdEnabled ?? false,
			},
			modules: {},
			shard: { name: "obsidian-mind", version: "6.0.0-beta.1" },
			valuesAreDefaults: overrides.valuesAreDefaults ?? true,
			newFiles: [],
			removedFiles: [],
		};
	}

	test("Invariant 2: leaves North Star byte-identical when valuesAreDefaults", async () => {
		await postInstall(makeCtx({ valuesAreDefaults: true }));
		const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.equal(after, NORTH_STAR_BASE);
	});

	test("personalizes North Star when valuesAreDefaults is false and user_name is set", async () => {
		await postInstall(makeCtx({ valuesAreDefaults: false, userName: "Jane Engineer" }));
		const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.match(after, /^# North Star — Jane Engineer$/m);
	});

	test("leaves North Star alone when valuesAreDefaults is false but user_name is empty", async () => {
		// Empty user_name means the user took the wizard but didn't enter a
		// name (some other value drove !valuesAreDefaults). Personalizing
		// with the empty string would produce the eyesore `# North Star — `;
		// the hook's secondary guard (userName.trim().length > 0) catches it.
		await postInstall(makeCtx({ valuesAreDefaults: false, userName: "" }));
		const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.equal(after, NORTH_STAR_BASE);
	});
});
