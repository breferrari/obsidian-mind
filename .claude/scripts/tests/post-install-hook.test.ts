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
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
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

async function makeVault(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `post-install-hook-${randomUUID()}-`));
	await mkdir(join(dir, "brain"), { recursive: true });
	await writeFile(join(dir, "brain", "North Star.md"), NORTH_STAR_BASE, "utf-8");
	return dir;
}

describe("personalizeNorthStar", () => {
	test("personalizes the heading with the supplied name", async () => {
		const vault = await makeVault();
		try {
			await personalizeNorthStar(vault, "Jane Engineer");
			const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
			assert.match(after, /^# North Star — Jane Engineer$/m);
			assert.equal(after.includes("# North Star\n"), false, "verbatim heading must be replaced");
		} finally {
			await rm(vault, { recursive: true, force: true });
		}
	});

	test("preserves the rest of the file byte-for-byte", async () => {
		const vault = await makeVault();
		try {
			await personalizeNorthStar(vault, "Jane Engineer");
			const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
			// Replace the personalized line back to the verbatim form and the
			// rest of the file must equal the input exactly. Pins that the hook
			// doesn't drop frontmatter, body content, trailing newline, or
			// otherwise reflow the file.
			const restored = after.replace(/^# North Star — Jane Engineer$/m, "# North Star");
			assert.equal(restored, NORTH_STAR_BASE);
		} finally {
			await rm(vault, { recursive: true, force: true });
		}
	});

	test("is idempotent — second run produces byte-identical content", async () => {
		const vault = await makeVault();
		try {
			await personalizeNorthStar(vault, "Jane Engineer");
			const afterFirst = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
			await personalizeNorthStar(vault, "Jane Engineer");
			const afterSecond = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
			assert.equal(afterSecond, afterFirst);
		} finally {
			await rm(vault, { recursive: true, force: true });
		}
	});

	test("idempotent against a different name once personalized", async () => {
		// Once personalized with name A, a later run with name B is a no-op.
		// Subsequent installs with a changed `user_name` value would have to
		// flow through `shardmind update`'s merge engine — the hook itself
		// never re-personalizes a file that's already been personalized.
		// Pins the anchor on `^# North Star$` (verbatim only).
		const vault = await makeVault();
		try {
			await personalizeNorthStar(vault, "Jane Engineer");
			const afterFirst = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
			await personalizeNorthStar(vault, "Different Person");
			const afterSecond = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
			assert.equal(afterSecond, afterFirst);
			assert.match(afterSecond, /^# North Star — Jane Engineer$/m);
		} finally {
			await rm(vault, { recursive: true, force: true });
		}
	});

	test("ENOENT-tolerant — missing North Star is a no-op", async () => {
		const vault = await mkdtemp(join(tmpdir(), `post-install-hook-${randomUUID()}-`));
		try {
			// brain/ exists but North Star.md doesn't — covers the case where
			// `brain` deselection (impossible today since `removable: false`,
			// but the guard costs nothing) or an upstream rename leaves the
			// path absent. The hook must not throw.
			await mkdir(join(vault, "brain"), { recursive: true });
			await personalizeNorthStar(vault, "Jane Engineer");
			// Nothing to assert about file contents — the guarantee is that
			// the call returned without throwing. We do verify the file
			// wasn't created as a side-effect.
			await assert.rejects(
				readFile(join(vault, "brain", "North Star.md"), "utf-8"),
				/ENOENT/,
			);
		} finally {
			await rm(vault, { recursive: true, force: true });
		}
	});
});

describe("ensureGitRepo", () => {
	test("skips when .git/ already exists", async () => {
		const vault = await mkdtemp(join(tmpdir(), `post-install-hook-${randomUUID()}-`));
		try {
			await mkdir(join(vault, ".git"), { recursive: true });
			// HEAD is one of the few files git always writes during init; if
			// the hook's skip-branch fires correctly, our pre-existing empty
			// .git/ stays empty.
			await ensureGitRepo(vault);
			await assert.rejects(
				readFile(join(vault, ".git", "HEAD"), "utf-8"),
				/ENOENT/,
				"ensureGitRepo must not run `git init` when .git/ already exists",
			);
		} finally {
			await rm(vault, { recursive: true, force: true });
		}
	});
});
