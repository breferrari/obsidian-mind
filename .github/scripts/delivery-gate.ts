#!/usr/bin/env node
/**
 * Delivery gate (#267): ask the model what it received, never the logs.
 *
 * Every check the template had confirmed that a hook RAN. None confirmed what
 * ARRIVED, and from Claude Code 2.1.89 to the #254 fix, hook output past
 * 10,000 characters reached the model as a 2,000-character preview while
 * every log said success. The mod moves the session context to a channel
 * (an instruction file) on a young API, so the same failure is possible
 * again. This gate runs real Claude Code sessions in a throwaway vault and
 * asks the model to quote the LAST line of the context it was given:
 *
 *  - with the mod: at startup, after `/compact`, after `/clear`, and from a
 *    general-purpose subagent;
 *  - without the mod: at startup (the settings-hook path stays the fallback).
 *
 * A missing or different last line fails the gate. Run it by hand on every
 * Claude Code release you recommend, with a logged-in `claude`:
 *
 *   node --experimental-strip-types .github/scripts/delivery-gate.ts [--model opus] [--claude <bin>]
 *
 * `--self-test` runs the mod path against a copy of the mod that cuts its
 * context to 2,000 characters. The gate must FAIL there; a gate that has
 * never failed is not yet a gate (#203).
 *
 * It costs a few model turns per run, and it is not wired to CI: a public
 * repository's CI has no credentials to give it.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../.claude/scripts/lib/main-guard.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The question asked at every checkpoint. */
export const QUESTION =
	"Without using any tool, quote verbatim the last line of the obsidian-mind session context you were given (the line that starts with _context injected). If you cannot see it, reply NONE.";

/** Asked once, after `/clear`: the same question, put to a general-purpose subagent. */
export const SUBAGENT_QUESTION =
	"Use the Agent tool to start one general-purpose subagent with this exact task: 'Without using any tool, reply with only the line in your own context or instructions that starts with _context injected, verbatim, or NONE if there is none.' Then reply with the subagent's answer verbatim and nothing else.";

export type Checkpoint = { readonly name: string; readonly prompt: string };

/** The turns of one session, in order: checkpoints are asked, the rest just run. */
export function plan(withMod: boolean): readonly Checkpoint[] {
	if (!withMod) return [{ name: "without the mod, at startup", prompt: QUESTION }];
	return [
		{ name: "at startup", prompt: QUESTION },
		{ name: "", prompt: "/compact" },
		{ name: "after /compact", prompt: QUESTION },
		{ name: "", prompt: "/clear" },
		{ name: "after /clear", prompt: QUESTION },
		{ name: "from a subagent", prompt: SUBAGENT_QUESTION },
	];
}

/** The last non-empty line of a text, trimmed. */
export function lastLine(text: string): string {
	return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";
}

/** Whether an answer quotes `expected`, ignoring the backticks and quotes a model wraps a line in. */
export function quotes(answer: string, expected: string): boolean {
	const bare = (s: string) => s.replace(/[`"“”]/g, "").replace(/\s+/g, " ").trim();
	return expected !== "" && bare(answer).includes(bare(expected));
}

/** Split a stream-json transcript into the assistant's text per turn (one entry per `result` event). */
export function answersByTurn(streamJson: string): string[] {
	const answers: string[] = [];
	let current = "";
	for (const raw of streamJson.split("\n")) {
		let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
		try {
			event = JSON.parse(raw);
		} catch {
			continue;
		}
		if (event.type === "assistant") {
			for (const block of event.message?.content ?? []) if (block.type === "text" && block.text) current += `${block.text}\n`;
		} else if (event.type === "result") {
			answers.push(current.trim());
			current = "";
		}
	}
	return answers;
}

/** A throwaway vault: the template's tracked files plus brain notes enough to put the context well past the hook cap. */
function buildFixture(selfTest: boolean): string {
	const vault = mkdtempSync(join(tmpdir(), "om-delivery-gate-"));
	const tracked = spawnSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8" }).stdout.split("\0").filter(Boolean);
	for (const file of tracked) {
		mkdirSync(dirname(join(vault, file)), { recursive: true });
		cpSync(join(REPO, file), join(vault, file));
	}
	for (let i = 1; i <= 150; i++) {
		const n = String(i).padStart(2, "0");
		writeFileSync(
			join(vault, "brain", `Gate Rule ${n}.md`),
			`---\ndescription: "Standing rule ${n}, long enough that seventy of these push the brain index past the hook-output cap"\ntags:\n  - brain\n---\n\n# Gate Rule ${n}\n\n${"Body. ".repeat(20)}\n`,
		);
	}
	if (selfTest) {
		const register = join(vault, ".claude/skills/obsidian-mind/hooks/register.ts");
		const source = readFileSync(register, "utf8");
		const cut = source.replace("await update($, sessionContext, () => text)", "await update($, sessionContext, () => text.slice(0, 2_000))");
		if (cut === source) throw new Error("self-test: the cut did not land; the mod changed shape");
		writeFileSync(register, cut);
	}
	spawnSync("git", ["init", "-q"], { cwd: vault });
	return vault;
}

/** What session-start.ts prints in the fixture, as the hook (`startup`) or as the mod's run (`deliver`). */
function contextOf(vault: string, deliver: boolean): string {
	const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", join(vault, ".claude/scripts/session-start.ts")], {
		cwd: vault,
		input: JSON.stringify({ source: "startup", ...(deliver ? { om_mod: "deliver" } : {}) }),
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: vault },
	});
	if (run.status !== 0) throw new Error(`session-start.ts failed: ${run.stderr}`);
	return run.stdout;
}

/** Run one paced session: each turn is sent once the previous one's result arrives. */
function session(vault: string, turns: readonly Checkpoint[], options: { claude: string; model: string; withMod: boolean }): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", options.model, "--setting-sources", "project,local", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--allowedTools", "Agent,Task", "--max-budget-usd", "5"];
		if (options.withMod) args.push("--plugin-dir", join(vault, ".claude/skills/obsidian-mind"));
		const child = spawn(options.claude, args, { cwd: vault, env: { ...process.env, DISABLE_AUTOUPDATER: "1" } });
		let out = "";
		let sent = 0;
		const send = () => {
			const turn = turns[sent++];
			if (!turn) return child.stdin.end();
			child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: turn.prompt } })}\n`);
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
			const results = (out.match(/"type":"result"/g) ?? []).length;
			if (results === sent) send();
		});
		child.on("error", reject);
		child.on("close", () => resolvePromise(out));
		send();
	});
}

type Verdict = { readonly checkpoint: string; readonly expected: string; readonly answer: string; readonly passed: boolean };

/** Judge one session's answers against the line its context ends with. */
export function judge(turns: readonly Checkpoint[], answers: readonly string[], expected: string): Verdict[] {
	return turns.flatMap((turn, i) => {
		if (turn.name === "") return [];
		const answer = answers[i] ?? "";
		return [{ checkpoint: turn.name, expected, answer: lastLine(answer), passed: quotes(answer, expected) }];
	});
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const flag = (name: string, fallback: string) => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
	};
	const selfTest = argv.includes("--self-test");
	const options = { claude: flag("--claude", "claude"), model: flag("--model", "opus") };
	const version = spawnSync(options.claude, ["--version"], { encoding: "utf8" }).stdout?.trim() || "unknown version";
	const vault = buildFixture(selfTest);
	try {
		const delivered = contextOf(vault, true);
		const hooked = contextOf(vault, false);
		// Well past the cap, so a cut anywhere near it shows as a different last line.
		if (delivered.length <= 15_000) throw new Error(`fixture too small to test the cap: ${delivered.length} characters`);

		const verdicts: Verdict[] = [];
		const withMod = plan(true);
		verdicts.push(...judge(withMod, answersByTurn(await session(vault, withMod, { ...options, withMod: true })), lastLine(delivered)));
		if (!selfTest) {
			const withoutMod = plan(false);
			verdicts.push(...judge(withoutMod, answersByTurn(await session(vault, withoutMod, { ...options, withMod: false })), lastLine(hooked)));
		}

		console.log(`Delivery gate · ${version} · ${options.model}${selfTest ? " · SELF-TEST (must fail)" : ""}`);
		console.log(`Context delivered by the mod: ${delivered.length} characters; as hook output: ${hooked.length}.\n`);
		for (const v of verdicts) console.log(`${v.passed ? "PASS" : "FAIL"}  ${v.checkpoint}\n      expected: ${v.expected}\n      answered: ${v.answer}`);
		const failed = verdicts.filter((v) => !v.passed).length;
		console.log(`\n${failed === 0 ? "All checkpoints received the whole context." : `${failed} checkpoint(s) did not receive the whole context.`}`);
		process.exitCode = failed === 0 ? 0 : 1;
	} finally {
		// On Windows the exited session can hold the folder briefly. A cleanup
		// failure must not turn a verdict into a crash, so it is only reported.
		try {
			rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
		} catch (error) {
			console.warn(`Could not remove the fixture ${vault}: ${(error as Error).message}`);
		}
	}
}

if (isMainModule(import.meta.url)) await main();
