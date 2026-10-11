/**
 * Layout guard (#321): AGENTS.md is the single shared instruction file.
 * Claude-only guidance lives under .claude/rules/, and legacy root files
 * must not return in a future migration.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("agent instruction layout", () => {
	test("has a substantive, size-capped shared instruction file", () => {
		const agents = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf-8");
		assert.match(agents, /## Vault Structure/);
		assert.match(agents, /## Write-Correctness Laws/);
		assert.ok(Buffer.byteLength(agents, "utf8") <= 22_000, "AGENTS.md exceeds 22,000 bytes; Antigravity may truncate it silently");
	});

	test("does not ship legacy root instruction files", () => {
		assert.equal(existsSync(resolve(repoRoot, "CLAUDE.md")), false);
		assert.equal(existsSync(resolve(repoRoot, "GEMINI.md")), false);
	});

	test("has non-empty Claude-only rule files", () => {
		const rulesDir = resolve(repoRoot, ".claude/rules");
		const expected = ["skills.md", "subagents.md", "memory.md", "hooks-and-mod.md"];
		assert.deepEqual(readdirSync(rulesDir).filter((name) => name.endsWith(".md")).sort(), expected.sort());
		for (const name of expected) {
			assert.ok(readFileSync(resolve(rulesDir, name), "utf8").trim().length > 0, `${name} is empty`);
		}
	});

	test("configures Gemini to load AGENTS.md", () => {
		const settings = JSON.parse(readFileSync(resolve(repoRoot, ".gemini/settings.json"), "utf8")) as { context?: { fileName?: unknown } };
		assert.deepEqual(settings.context?.fileName, ["AGENTS.md"]);
	});
});
