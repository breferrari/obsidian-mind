/**
 * Unit tests for lib/project-dir.ts — which project directory a hook runs
 * against, whichever of the three agents called it.
 */

import { after, before, describe, test } from "node:test";
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
	// A real vault on disk, with a second vault nested inside it.
	let root = "";
	let inner = "";
	before(() => {
		root = mkdtempSync(join(tmpdir(), "pd-root-"));
		inner = join(root, "nested-vault");
		mkdirSync(join(root, "work", "deep"), { recursive: true });
		mkdirSync(join(inner, "work"), { recursive: true });
		writeFileSync(join(root, VAULT_MARKER), "{}");
		writeFileSync(join(inner, VAULT_MARKER), "{}");
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	test("a subfolder resolves to the vault root above it", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: join(root, "work", "deep") }), root);
	});

	test("the root itself resolves to itself", () => {
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: root }), root);
	});

	test("the nearest root wins: a vault inside another vault resolves to the inner one", () => {
		// Starting the search above the named folder would skip the inner root
		// and land on the outer one; the fallback could not hide that here.
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: inner }), inner);
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: join(inner, "work") }), inner);
	});

	test("no vault root above the named folder keeps the named folder", { skip: nearestVaultRoot(tmpdir()) !== null ? "the temp folder is inside a vault on this machine" : false }, () => {
		const elsewhere = join(tmpdir(), "pd-elsewhere", "x");
		assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: elsewhere }), elsewhere);
	});

	test("the fallback is walked up too", () => {
		assert.equal(resolveProjectDir(join(root, "work"), {}), root);
	});

	test("on a real filesystem the marker is vault-manifest.json", () => {
		const vault = mkdtempSync(join(tmpdir(), "pd-vault-"));
		try {
			mkdirSync(join(vault, "work", "deep"), { recursive: true });
			writeFileSync(join(vault, VAULT_MARKER), "{}");
			assert.equal(VAULT_MARKER, "vault-manifest.json", "the hook commands in settings.json look for this same literal");
			assert.equal(resolveProjectDir("/fb", { CLAUDE_PROJECT_DIR: join(vault, "work", "deep") }), vault);
			assert.equal(nearestVaultRoot(join(vault, "work")), vault);
		} finally {
			rmSync(vault, { recursive: true, force: true });
		}
	});
});
