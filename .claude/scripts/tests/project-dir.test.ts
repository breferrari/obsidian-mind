/**
 * Unit tests for lib/project-dir.ts — which project directory a hook runs
 * against, whichever of the three agents called it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nearestVaultRoot, resolveProjectDir, VAULT_MARKER } from "../lib/project-dir.ts";

describe("resolveProjectDir", () => {
	test("each agent's variable is honoured", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: "/c" }), "/c");
		assert.equal(resolveProjectDir("/fb", { CODEX_PROJECT_DIR: "/x" }), "/x");
		assert.equal(resolveProjectDir("/fb", { GEMINI_PROJECT_DIR: "/g" }), "/g");
	});

	test("Claude, then Codex, then Gemini", () => {
		const all = { CLAUDE_PROJECT_DIR: "/c", CODEX_PROJECT_DIR: "/x", GEMINI_PROJECT_DIR: "/g" };
		assert.equal(resolveProjectDir("/fb", all), "/c");
		assert.equal(resolveProjectDir("/fb", { CODEX_PROJECT_DIR: "/x", GEMINI_PROJECT_DIR: "/g" }), "/x");
	});

	test("an empty value counts as unset", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: "", CODEX_PROJECT_DIR: "/x" }), "/x");
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: "" }), "/fb");
	});

	test("no variable falls back to the caller's choice", () => {
		assert.equal(resolveProjectDir("/fb", {}), "/fb");
	});
});

/**
 * #263: Claude Code's CLAUDE_PROJECT_DIR names the folder the session was
 * launched in and does not follow `/cd`, so it can name a vault subfolder.
 * The result walks up to the nearest folder holding vault-manifest.json.
 */
describe("resolveProjectDir — finds the vault root above the named folder", () => {
	const root = join(tmpdir(), "pd-root");
	const isRoot = (dir: string) => dir === root;

	test("a subfolder resolves to the vault root above it", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: join(root, "work", "deep") }, isRoot), root);
	});

	test("the root itself resolves to itself", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: root }, isRoot), root);
	});

	test("the nearest root wins: a vault inside another vault resolves to the inner one", () => {
		// Starting the search above the named folder would skip the inner root
		// and land on the outer one; the fallback could not hide that here.
		const inner = join(root, "nested-vault");
		const both = (dir: string) => dir === root || dir === inner;
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: inner }, both), inner);
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: join(inner, "work") }, both), inner);
	});

	test("no vault root above the named folder keeps the named folder", () => {
		const elsewhere = join(tmpdir(), "pd-elsewhere", "x");
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: elsewhere }, isRoot), elsewhere);
	});

	test("the fallback is walked up too", () => {
		assert.equal(resolveProjectDir(join(root, "work"), {}, isRoot), root);
	});

	test("on a real filesystem the marker is vault-manifest.json", () => {
		const vault = mkdtempSync(join(tmpdir(), "pd-vault-"));
		try {
			mkdirSync(join(vault, "work", "deep"), { recursive: true });
			writeFileSync(join(vault, VAULT_MARKER), "{}");
			assert.equal(VAULT_MARKER, "vault-manifest.json");
			assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: join(vault, "work", "deep") }), vault);
			assert.equal(nearestVaultRoot(join(vault, "work")), vault);
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});
});
