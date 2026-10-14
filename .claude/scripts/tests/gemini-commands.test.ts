/**
 * The om commands under Gemini CLI (#356). Gemini reads custom commands only
 * as TOML from `.gemini/commands/`, so each `.claude/commands/om-*.md` gets a
 * wrapper there whose prompt injects the command file with `@{…}`: the
 * command's text is read live, with no copy to drift. The wrappers are
 * generated (`.scripts/gemini-commands.ts`); this checks they match, one per
 * command and none left over.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commandDescription, geminiCommand } from "../../../.scripts/gemini-commands.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMANDS = join(REPO, ".claude", "commands");
const WRAPPERS = join(REPO, ".gemini", "commands");

test("every om command has its Gemini wrapper, as generated", () => {
	const stale: string[] = [];
	for (const file of readdirSync(COMMANDS).filter((f) => /^om-.+\.md$/.test(f))) {
		const name = file.replace(/\.md$/, "");
		const wrapper = join(WRAPPERS, `${name}.toml`);
		const expected = geminiCommand(name, readFileSync(join(COMMANDS, file), "utf8"));
		if (!existsSync(wrapper) || readFileSync(wrapper, "utf8") !== expected) stale.push(name);
	}
	assert.deepEqual(stale, [], "run: node --experimental-strip-types .scripts/gemini-commands.ts");
});

test("no wrapper outlives its command", () => {
	const commands = new Set(readdirSync(COMMANDS).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")));
	const orphans = (existsSync(WRAPPERS) ? readdirSync(WRAPPERS) : [])
		.filter((f) => /^om-.+\.toml$/.test(f))
		.map((f) => f.replace(/\.toml$/, ""))
		.filter((name) => !commands.has(name));
	assert.deepEqual(orphans, []);
});

test("a wrapper injects the command, passes the arguments, and maps $ARGUMENTS onto them", () => {
	const toml = geminiCommand("om-dump", '---\ndescription: "Freeform capture."\n---\n\nUse $ARGUMENTS.\n');
	assert.match(toml, /^description = "Freeform capture\."$/m);
	assert.ok(toml.includes("@{.claude/commands/om-dump.md}"), "the command file is injected, not copied");
	assert.ok(toml.includes("{{args}}"), "Gemini's arguments are passed");
	assert.match(toml, /\$ARGUMENTS/, "and the wrapper says what $ARGUMENTS means here");
});

test("the description comes from frontmatter, else the first line of prose, escaped for TOML", () => {
	assert.equal(commandDescription('---\ndescription: "Morning kickoff."\n---\n\nRun it.\n'), "Morning kickoff.");
	assert.equal(commandDescription("# Wrap Up\n\nFull session review before ending.\n\n## Usage\n"), "Full session review before ending.");
	assert.match(geminiCommand("om-x", '---\ndescription: "Say \\"hi\\" — now."\n---\n'), /^description = "Say \\"hi\\" — now\."$/m);
});
