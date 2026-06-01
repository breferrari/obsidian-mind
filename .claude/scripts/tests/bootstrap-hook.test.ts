/**
 * Unit tests for the v6 bootstrap hook (.shardmind/hooks/bootstrap.ts).
 *
 * Bootstrap owns the unmanaged-artifact responsibilities — git init and the
 * QMD index — split out of the legacy post-install hook. Drives the exported
 * `ensureGitRepo` and the default-export orchestration against synthetic
 * vaults under a per-test temp directory. The subprocess paths (`git init`,
 * `node qmd-bootstrap.ts`) get integration coverage through ShardMind's
 * contract suite when it runs against this shard; here we exercise the
 * skip/gate branches that avoid spawning.
 *
 * Each test gets its own `os.tmpdir() + crypto.randomUUID()` directory to
 * avoid the parallel-load flake pattern documented in the take-next skill.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import bootstrap, { ensureGitRepo } from "../../../.shardmind/hooks/bootstrap.ts";

async function makeTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `${prefix}-${randomUUID()}-`));
}

const isENOENT = (err: unknown): boolean =>
	(err as NodeJS.ErrnoException).code === "ENOENT";

describe("ensureGitRepo", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await makeTempDir("bootstrap-hook");
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

describe("bootstrap (default export) — orchestration gates", () => {
	// Pre-creates `.git/` to short-circuit `ensureGitRepo` (avoiding a real
	// `git init` subprocess) and pins `qmd_enabled: false` so `bootstrapQmd`
	// is gated off — leaving bootstrap a no-op that must not write anything.
	let vault: string;

	beforeEach(async () => {
		vault = await makeTempDir("bootstrap-hook");
		await mkdir(join(vault, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	function makeCtx(overrides: Partial<{ qmdEnabled: boolean }>): {
		slot: "bootstrap";
		vaultRoot: string;
		values: Record<string, unknown>;
		modules: Record<string, "included" | "excluded">;
		shard: { name: string; version: string };
		previousVersion?: string;
	} {
		return {
			slot: "bootstrap",
			vaultRoot: vault,
			values: {
				user_name: "Jane Engineer",
				org_name: "Independent",
				vault_purpose: "engineering",
				qmd_enabled: overrides.qmdEnabled ?? false,
			},
			modules: {},
			shard: { name: "obsidian-mind", version: "6.2.0" },
		};
	}

	test("no-op when .git/ exists and qmd is disabled — writes nothing", async () => {
		await bootstrap(makeCtx({ qmdEnabled: false }));
		// git init skipped (HEAD absent) and qmd gated off (.qmd absent).
		await assert.rejects(readFile(join(vault, ".git", "HEAD"), "utf-8"), isENOENT);
		await assert.rejects(readFile(join(vault, ".qmd", "config.json"), "utf-8"), isENOENT);
	});
});
