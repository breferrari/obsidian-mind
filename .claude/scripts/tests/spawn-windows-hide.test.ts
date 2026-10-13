/**
 * Every process this repo's scripts start passes `windowsHide` (#390).
 *
 * On Windows, a console program started without it from a process that has no
 * console of its own (a detached worker, a hook, an MCP server) opens a
 * console window. Under Windows Terminal as the default terminal that is a
 * visible window per spawn: a session start once flooded the screen with them
 * (#381, #384). The flag is easy to drop and nothing else notices: the
 * behaviour only shows on a Windows desktop. So this reads the source and
 * checks every direct spawn call, the way mindframe's qmd extension does.
 *
 * A spawn that must share its parent's console (stdio inherited end to end)
 * goes on the allowlist with its reason; the flag couldn't hide anything
 * there, because libuv sets CREATE_NO_WINDOW only when no stdio is inherited.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(SCRIPTS));

/** Spawn calls that may omit the flag, by file and a snippet of the call. */
const ALLOWED: ReadonlyArray<{ readonly file: string; readonly call: string; readonly why: string }> = [
	{
		file: ".claude/scripts/om-mcp.mjs",
		call: 'stdio: "inherit"',
		why: "the MCP server launcher: the child IS the server and speaks over the inherited stdio",
	},
	{
		file: ".claude/scripts/qmd-mcp.mjs",
		call: 'stdio: "inherit"',
		why: "qmd's MCP stdio server: it speaks over the inherited stdio",
	},
];

const SPAWN_NAMES = ["spawnSync", "spawn", "execSync", "execFileSync", "execFile"];

/**
 * The calls that start a process in `code`: node's spawn functions, called bare
 * or through a namespace (`cp.spawn(`), and any seam parameter typed as one of
 * them (`spawnChild: typeof spawn`), which is how a spawn reaches a test.
 */
function spawnPattern(code: string): RegExp {
	const seams = [...code.matchAll(new RegExp(`(\\w+)\\s*:\\s*typeof\\s+(?:${SPAWN_NAMES.join("|")})\\b`, "g"))].map(
		(m) => m[1]!,
	);
	return new RegExp(`(?<![\\w$])(?:\\w+\\.)?(${[...SPAWN_NAMES, ...seams].join("|")})\\(`, "g");
}

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "tests") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sources(path));
		else if (/\.(ts|mjs)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".d.mts")) out.push(path);
	}
	return out;
}

/** The text of the call starting at the "(" at `open`, through its matching ")". */
function callText(text: string, open: number): string {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
	}
	return text.slice(open);
}

test("every spawn in .claude/scripts and .scripts passes windowsHide, or is allowlisted with a reason", () => {
	const missing: string[] = [];
	const allowUsed = new Set<string>();
	for (const file of [...sources(SCRIPTS), ...sources(join(REPO, ".scripts"))]) {
		const rel = relative(REPO, file).replaceAll("\\", "/");
		// Comment lines are dropped (a doc comment may quote a spawn); code lines
		// are kept whole, since a URL inside a call holds "//".
		const code = readFileSync(file, "utf8")
			.split("\n")
			.map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
			.join("\n");
		for (const m of code.matchAll(spawnPattern(code))) {
			const call = callText(code, m.index! + m[0].length - 1);
			if (/windowsHide/.test(call)) continue;
			const allowed = ALLOWED.find((a) => a.file === rel && call.includes(a.call));
			if (allowed) {
				allowUsed.add(`${allowed.file} ${allowed.call}`);
				continue;
			}
			const line = code.slice(0, m.index).split("\n").length;
			missing.push(`${rel}:${line} ${m[1]}(…) has no windowsHide`);
		}
	}
	assert.deepEqual(missing, [], `pass windowsHide: true, or allowlist the call with its reason:\n${missing.join("\n")}`);
	// An allowlist entry that matches nothing has outlived its spawn.
	assert.deepEqual(
		ALLOWED.filter((a) => !allowUsed.has(`${a.file} ${a.call}`)).map((a) => a.file),
		[],
		"remove allowlist entries that no longer match a spawn",
	);
});
