/**
 * Unit tests for the v6 personalize hook (.shardmind/hooks/personalize.ts).
 *
 * Personalize owns the managed-file responsibility — the North Star heading —
 * split out of the legacy post-install hook. Drives the exported
 * `personalizeNorthStar` and the default-export against synthetic vaults under
 * a per-test temp directory.
 *
 * NOTE on Invariant 2: the legacy post-install suite asserted that the hook
 * left North Star byte-identical when `valuesAreDefaults === true`. That
 * contract no longer lives here — the engine refuses to call `personalize` at
 * all on an all-defaults install (Invariant 2 is engine-enforced), and
 * `PersonalizeContext` carries no `valuesAreDefaults` flag for the hook to
 * check. The "engine skips personalize on defaults" assertion now belongs to
 * ShardMind's engine test suite. What remains testable here: given the hook
 * IS called, an empty `user_name` is still a no-op (the hook's secondary
 * guard), and a non-empty name personalizes once and is idempotent.
 *
 * Each test gets its own `os.tmpdir() + crypto.randomUUID()` directory to
 * avoid the parallel-load flake pattern documented in the take-next skill.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import personalize, {
	personalizeNorthStar,
} from "../../../.shardmind/hooks/personalize.ts";

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
		vault = await makeTempDir("personalize-hook");
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
		vault = await makeTempDir("personalize-hook");
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

describe("personalize (default export) — empty-name guard", () => {
	// The engine only reaches this hook when values are non-default, so there
	// is no `valuesAreDefaults` branch to drive. The remaining hook-side gate
	// is the empty-`user_name` guard: a non-default install with a blank name
	// must leave North Star untouched rather than write `# North Star — `.
	let vault: string;

	beforeEach(async () => {
		vault = await makeTempDir("personalize-hook");
		await mkdir(join(vault, "brain"), { recursive: true });
		await writeFile(join(vault, "brain", "North Star.md"), NORTH_STAR_BASE, "utf-8");
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	function makeCtx(overrides: Partial<{ userName: string }>): {
		slot: "personalize";
		vaultRoot: string;
		values: Record<string, unknown>;
		modules: Record<string, "included" | "excluded">;
		shard: { name: string; version: string };
	} {
		return {
			slot: "personalize",
			vaultRoot: vault,
			values: {
				user_name: overrides.userName ?? "",
				org_name: "Independent",
				vault_purpose: "engineering",
				qmd_enabled: false,
			},
			modules: {},
			shard: { name: "obsidian-mind", version: "6.2.0" },
		};
	}

	test("personalizes North Star when user_name is set", async () => {
		await personalize(makeCtx({ userName: "Jane Engineer" }));
		const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.match(after, /^# North Star — Jane Engineer$/m);
	});

	test("leaves North Star alone when user_name is empty", async () => {
		// Empty user_name means the user took the wizard but didn't enter a
		// name (some other value drove the non-default install). Personalizing
		// with the empty string would produce the eyesore `# North Star — `;
		// the hook's secondary guard (userName.trim().length > 0) catches it.
		await personalize(makeCtx({ userName: "" }));
		const after = await readFile(join(vault, "brain", "North Star.md"), "utf-8");
		assert.equal(after, NORTH_STAR_BASE);
	});
});
