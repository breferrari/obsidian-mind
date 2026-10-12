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

import { AGENTS_MD_MAX_BYTES } from "../lib/instruction-files.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

	test("AGENTS.md is LF-only, so its size is the same on every checkout", () => {
		// .gitattributes forces eol=lf; a CRLF checkout would add a byte per
		// line (~300) and move the file toward the cap on Windows only.
		assert.ok(!readFileSync(agentsPath, "utf-8").includes("\r"), "AGENTS.md has CRLF line endings");
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

	/** The `.claude/rules/*.md` files AGENTS.md's pointers name. */
	const pointerTargets = (): string[] => [
		...new Set([...readFileSync(agentsPath, "utf-8").matchAll(/`(\.claude\/rules\/[\w.-]+\.md)`/g)].map((m) => m[1]!)),
	];
	const SHARED_LINE =
		"Shared section: Claude Code and Grok load it at session start; other agents read it when AGENTS.md points here.";

	test("every rules file AGENTS.md points at exists, is non-empty, and says it is shared", () => {
		const targets = pointerTargets();
		assert.ok(targets.length > 0, "AGENTS.md names no .claude/rules/ file: the moved sections have no pointer");
		for (const t of targets) {
			const p = resolve(repoRoot, t);
			assert.ok(existsSync(p), `AGENTS.md points at ${t}, which does not exist`);
			const text = readFileSync(p, "utf-8");
			assert.ok(text.trim().length > 0, `${t} is empty`);
			assert.equal(text.split("\n")[0], SHARED_LINE, `${t} does not open with the shared-section line`);
		}
	});

	test("every shared rules file is pointed at by AGENTS.md, so no agent but Claude Code and Grok is cut off from it", () => {
		const targets = new Set(pointerTargets());
		const dir = resolve(repoRoot, ".claude/rules");
		for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
			const shared = readFileSync(resolve(dir, f), "utf-8").startsWith(SHARED_LINE);
			assert.equal(targets.has(`.claude/rules/${f}`), shared, `.claude/rules/${f}: ${shared ? "shared but AGENTS.md never points at it" : "Claude-only but AGENTS.md points at it"}`);
		}
	});

	test("every file AGENTS.md points at is claimed by no removable module, so every module selection installs it", () => {
		// A file claimed by a removable module disappears when that module is
		// deselected, and a Codex-only vault would then follow a pointer to
		// nothing. Shared files must be core: claimed by no removable module.
		const schema = readFileSync(resolve(repoRoot, ".shardmind/shard-schema.yaml"), "utf-8");
		const modulesBlock = schema.slice(schema.indexOf("\nmodules:\n"), schema.indexOf("\nsignals:\n"));
		const modules = modulesBlock.split(/\n  (?=[a-z_]+:\n)/).slice(1);
		// A module's `paths`, written either as a flow list (`paths: ["a/"]`)
		// or as a block list of `- "a/"` lines; the schema uses both.
		const pathsOf = (m: string): string[] => {
			const flow = /\n    paths: \[([^\]]*)\]/.exec(m);
			if (flow) return [...flow[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
			const block = /\n    paths:\n((?:      - "[^"]+"\n|      #[^\n]*\n)+)/.exec(m);
			return block ? [...block[1]!.matchAll(/- "([^"]+)"/g)].map((x) => x[1]!) : [];
		};
		assert.ok(pathsOf(modules.find((m) => m.startsWith("brain:"))!).includes("brain/"), "pathsOf misreads a flow-style list");
		const removablePaths = modules.filter((m) => /\n    removable: true\b/.test(m)).flatMap(pathsOf);
		assert.ok(modules.length > 0, "found no modules in shard-schema.yaml");
		const claims = (path: string, claim: string) => (claim.endsWith("/") ? path.startsWith(claim) : path === claim);
		for (const t of [...pointerTargets(), "AGENTS.md"]) {
			const by = removablePaths.find((c) => claims(t, c));
			assert.equal(by, undefined, `${t} is claimed by a removable module (${by}), so a vault without that module loses it`);
		}
		// And the Claude module, removable or not, claims only the Claude-only files.
		const claude = modules.find((m) => m.startsWith("claude:"))!;
		const claudePaths = pathsOf(claude);
		assert.ok(!claudePaths.includes(".claude/rules/"), "the Claude module claims all of .claude/rules/, shared files included");
		const dir = resolve(repoRoot, ".claude/rules");
		const claudeOnly = readdirSync(dir)
			.filter((f) => f.endsWith(".md") && !readFileSync(resolve(dir, f), "utf-8").startsWith(SHARED_LINE))
			.map((f) => `.claude/rules/${f}`)
			.sort();
		assert.deepEqual(
			claudePaths.filter((p) => p.startsWith(".claude/rules/")).sort(),
			claudeOnly,
			"the Claude module must claim exactly the Claude-only rules files",
		);
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
