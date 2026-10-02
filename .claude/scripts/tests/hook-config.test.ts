/**
 * Hook config regression tests.
 *
 * These tests lock in the CWD-independent hook invocation pattern from
 * issue #45 / commit 0f36db7. Every hook command in every agent config
 * must resolve its script path through the agent's own *_PROJECT_DIR
 * env var so the hook keeps working when the invoking shell's CWD
 * drifts away from the project root.
 *
 * The original failure mode: a drifted shell CWD caused relative paths
 * like `.claude/scripts/stop-checklist.ts` to resolve against the wrong
 * directory and fail with MODULE_NOT_FOUND. An earlier fix (0f36db7)
 * was reverted (89bb963) without a recorded rationale; the replacement
 * fix re-applies the same pattern. This test exists so the revert
 * doesn't silently happen a third time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type HookConfig = {
	readonly hooks?: Record<
		string,
		ReadonlyArray<{
			readonly hooks?: ReadonlyArray<{
				readonly type?: string;
				readonly command?: string;
			}>;
		}>
	>;
};

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

const configs: ReadonlyArray<{
	readonly label: string;
	readonly path: string;
	readonly envVar: string;
}> = [
	{
		label: "Claude Code",
		path: ".claude/settings.json",
		envVar: "CLAUDE_PROJECT_DIR",
	},
	{
		label: "Codex CLI",
		path: ".codex/hooks.json",
		envVar: "CODEX_PROJECT_DIR",
	},
	{
		label: "Gemini CLI",
		path: ".gemini/settings.json",
		envVar: "GEMINI_PROJECT_DIR",
	},
];

function loadConfig(relPath: string): HookConfig {
	const raw = readFileSync(resolve(repoRoot, relPath), { encoding: "utf-8" });
	return JSON.parse(raw) as HookConfig;
}

function eachNodeHookCommand(
	cfg: HookConfig,
): Array<{ readonly event: string; readonly command: string }> {
	const out: Array<{ event: string; command: string }> = [];
	const events = cfg.hooks ?? {};
	for (const [event, entries] of Object.entries(events)) {
		for (const entry of entries) {
			for (const hook of entry.hooks ?? []) {
				if (hook.type !== "command" || typeof hook.command !== "string") continue;
				// Only hooks that run the TS scripts are subject to the CWD-
				// resolution rule; inline shell commands (e.g. the printf
				// checklist used by Codex/Gemini Stop/SessionEnd) are fine.
				if (!hook.command.includes(".claude/scripts/")) continue;
				out.push({ event, command: hook.command });
			}
		}
	}
	return out;
}

describe("hook config — CWD-independent script resolution (issue #45)", () => {
	for (const { label, path, envVar } of configs) {
		describe(`${label} (${path})`, () => {
			const cfg = loadConfig(path);
			const commands = eachNodeHookCommand(cfg);

			test("at least one TS hook command is declared", () => {
				assert.ok(
					commands.length > 0,
					`expected ${path} to declare node-based hook commands`,
				);
			});

			for (const { event, command } of commands) {
				test(`${event} uses \${${envVar}:-.}/ prefix`, () => {
					assert.ok(
						command.includes(`\${${envVar}:-.}/.claude/scripts/`),
						`${path} ${event} command must resolve scripts via \${${envVar}:-.}/ to survive CWD drift — got:\n  ${command}`,
					);
				});

				test(`${event} does not use a bare relative .claude/scripts/ path`, () => {
					// A bare relative path only survives if the invoking shell's
					// CWD is the project root — which is exactly the assumption
					// that broke in #45. Enforce the env-var-prefixed form.
					const bareRelative = / \.claude\/scripts\//.test(command);
					const envPrefixed = command.includes(
						`\${${envVar}:-.}/.claude/scripts/`,
					);
					assert.ok(
						!bareRelative || envPrefixed,
						`${path} ${event} has a bare .claude/scripts/ path — ${command}`,
					);
				});
			}
		});
	}
});

/**
 * The checklist hook runs on the event that can actually show its message.
 *
 * Claude Code and Codex: Stop, deduped inside the script to once per session
 * plus on change (#252). Not SessionEnd: Claude Code discards a SessionEnd
 * hook's `systemMessage` ("Claude Code discards their JSON output fields,
 * such as systemMessage" — hooks reference), and Codex documents SessionEnd
 * as advisory and leaves it out of the events whose `systemMessage` it
 * surfaces. Wiring the checklist there turns "every turn" into "never".
 *
 * Gemini CLI: SessionEnd, whose `systemMessage` is "Displayed to the user
 * during shutdown" (best effort). Gemini's per-turn event is AfterAgent, and
 * the checklist is not wired to it.
 *
 * Pin the routing so a config edit cannot move the message somewhere it
 * silently disappears, or back to an undeduped per-turn surface.
 */
const CHECKLIST_EVENT: Readonly<Record<string, string>> = {
	"Claude Code": "Stop",
	"Codex CLI": "Stop",
	"Gemini CLI": "SessionEnd",
};

describe("hook config — the checklist runs where its message is shown", () => {
	for (const { label, path } of configs) {
		const checklistHooks = eachNodeHookCommand(loadConfig(path)).filter(
			({ command }) => command.includes("stop-checklist.ts"),
		);
		const expected = CHECKLIST_EVENT[label];
		const events = checklistHooks.map(({ event }) => event);

		test(`${label} wires the checklist exactly once, on ${expected}`, () => {
			assert.deepEqual(
				events,
				[expected],
				`expected ${path} to invoke stop-checklist.ts once, on ${expected} — got ${JSON.stringify(events)}`,
			);
		});

		test(`${label} passes the checklist hook no arguments`, () => {
			assert.match(
				checklistHooks[0]?.command ?? "",
				/stop-checklist\.ts"$/,
				`${path} must invoke stop-checklist.ts with no trailing arguments — its output contract is the same for every agent`,
			);
		});
	}
});
