/**
 * Which writes refresh this vault's QMD index (#366). A `.md` written outside
 * the vault can't change the index, so it starts no refresh worker. Inside the
 * vault, paths the validation skips (templates, root docs) still refresh,
 * because they are indexed all the same.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { refreshesVaultIndex } from "../lib/qmd-refresh.ts";

const VAULT = resolve("/vault");
const fwd = (p: string) => p.replaceAll("\\", "/");

test("a note inside the vault refreshes, skipped by validation or not", () => {
	for (const rel of [join("work", "active", "Plan.md"), join("templates", "Work Note.md"), "README.md"]) {
		assert.equal(refreshesVaultIndex(join(VAULT, rel), fwd(VAULT)), true, rel);
	}
});

test("a note outside the vault refreshes nothing", () => {
	assert.equal(refreshesVaultIndex(join(resolve("/elsewhere"), "README.md"), fwd(VAULT)), false);
	assert.equal(refreshesVaultIndex(join(resolve("/vaulting"), "note.md"), fwd(VAULT)), false, "a sibling whose name starts like the vault");
});

test("inside the vault, the extension and skip rules still apply", () => {
	assert.equal(refreshesVaultIndex(join(VAULT, "code.ts"), fwd(VAULT)), false);
	assert.equal(refreshesVaultIndex(join(VAULT, ".git", "x.md"), fwd(VAULT)), false);
});
