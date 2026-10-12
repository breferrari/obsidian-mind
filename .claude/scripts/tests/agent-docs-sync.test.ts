/**
 * Layout pin (#321): `AGENTS.md` is the vault's one instruction file.
 *
 * Every agent reads it: Codex and Antigravity natively, Grok once the folder
 * is trusted, Gemini through `.gemini/settings.json`'s `context.fileName`, and
 * Claude Code natively when no `CLAUDE.md` is present. Claude-only guidance
 * lives in `.claude/rules/*.md`, which Claude Code loads beside it.
 *
 * What would quietly undo that:
 * - a `CLAUDE.md` back at the root: Claude Code reads it and skips
 *   `AGENTS.md` without saying so;
 * - a `GEMINI.md` back at the root, or the Gemini setting dropped: Gemini
 *   falls back to looking for `GEMINI.md`;
 * - `AGENTS.md` turned back into a pointer at another file, which Codex
 *   never follows unless told to;
 * - `AGENTS.md` growing past what the agents read: Antigravity cuts it off
 *   silently past ~24,000 bytes (measured), Codex past ~32 KiB.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Where the test fails. Antigravity truncated a 36 KB `AGENTS.md` between
 * byte 23,860 and byte 24,305 (#321); this leaves ~2 KB of margin under that,
 * and ~1 KB above the file as shipped for the template to grow into.
 */
const AGENTS_MD_MAX_BYTES = 22_000;

describe("AGENTS.md is the one instruction file (#321)", () => {
	const agentsPath = resolve(repoRoot, "AGENTS.md");

	test("AGENTS.md exists and carries the conventions itself, not a pointer to another file", () => {
		assert.ok(existsSync(agentsPath), "AGENTS.md is missing from the vault root");
		const text = readFileSync(agentsPath, "utf-8");
		// Headings every agent needs at the moment of acting (#321: these stay
		// inline because a skipped pointer means a misplaced note or a record
		// never written).
		for (const heading of ["## Vault Structure", "### Note Types", "### Decision Records", "## Write-Correctness Laws", "## Rules"]) {
			assert.ok(text.includes(`\n${heading}\n`), `AGENTS.md lost its "${heading}" section`);
		}
		assert.doesNotMatch(text, /Read `CLAUDE\.md` for all vault conventions/, "AGENTS.md is a pointer to CLAUDE.md again");
	});

	test(`AGENTS.md stays under ${AGENTS_MD_MAX_BYTES} bytes`, () => {
		const size = statSync(agentsPath).size;
		assert.ok(
			size < AGENTS_MD_MAX_BYTES,
			`AGENTS.md is ${size} bytes, at or over the ${AGENTS_MD_MAX_BYTES}-byte threshold. Antigravity silently stops reading it at ~24,000 bytes (and Codex at ~32 KiB). Move a section an agent can safely skip to a file it reads on demand, verbatim, and leave a one-line pointer (#321).`,
		);
	});

	test("no CLAUDE.md or GEMINI.md at the vault root", () => {
		// Claude Code reads a CLAUDE.md in place of AGENTS.md, silently.
		assert.ok(!existsSync(resolve(repoRoot, "CLAUDE.md")), "CLAUDE.md is back at the root: Claude Code reads it and skips AGENTS.md");
		assert.ok(!existsSync(resolve(repoRoot, "GEMINI.md")), "GEMINI.md is back at the root: Gemini reads AGENTS.md through .gemini/settings.json instead");
	});

	test(".gemini/settings.json points Gemini at AGENTS.md", () => {
		const settings = JSON.parse(readFileSync(resolve(repoRoot, ".gemini/settings.json"), "utf-8")) as {
			context?: { fileName?: unknown };
		};
		const names = settings.context?.fileName;
		assert.ok(Array.isArray(names) && names.includes("AGENTS.md"), ".gemini/settings.json context.fileName must list AGENTS.md");
	});

	test("every .claude/rules/*.md exists and is non-empty", () => {
		const dir = resolve(repoRoot, ".claude/rules");
		assert.ok(existsSync(dir), ".claude/rules/ is missing: the Claude-only guidance has nowhere to load from");
		const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
		for (const name of ["skills.md", "subagents.md", "memory.md", "hooks-and-mod.md"]) {
			assert.ok(files.includes(name), `.claude/rules/${name} is missing`);
		}
		for (const f of files) {
			assert.ok(readFileSync(resolve(dir, f), "utf-8").trim().length > 0, `.claude/rules/${f} is empty`);
		}
	});
});
