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
 *
 * Claude Code's commands go one step further (#263): CLAUDE_PROJECT_DIR is
 * the folder the session was launched in and does not follow `/cd`, so it can
 * name a vault subfolder. They start from `${CLAUDE_PROJECT_DIR:-.}` and
 * walk up to the nearest folder holding vault-manifest.json. The last block
 * runs each real command to prove it.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nearestVaultRoot } from "../lib/project-dir.ts";

type HookConfig = {
	readonly hooks?: Record<
		string,
		ReadonlyArray<{
			readonly hooks?: ReadonlyArray<{
				readonly type?: string;
				readonly command?: string;
				readonly commandWindows?: string;
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
				if (envVar === "GEMINI_PROJECT_DIR") {
					// #268: Gemini runs every hook as `powershell.exe -NoProfile -Command`
					// on Windows (bash -c elsewhere), with the SESSION cwd as working
					// directory and GEMINI_PROJECT_DIR set to that same cwd. So the
					// relative path is exactly what `${GEMINI_PROJECT_DIR:-.}/` meant on
					// POSIX — and the braced form never expanded under PowerShell. The
					// #45 drift (a tool shell's `cd` leaking into the next hook) is a
					// Claude Code shape: Gemini never runs hooks in a tool shell.
					test(`${event} is a plain relative path, with no shell expansion`, () => {
						assert.match(command, / \.claude\/scripts\/[a-z-]+\.ts$/, `${path} ${event}: ${command}`);
						assert.ok(!command.includes("$"), `${path} ${event} must not depend on any shell's expansion: ${command}`);
					});
					continue;
				}
				if (envVar === "CLAUDE_PROJECT_DIR") {
					// Claude Code does not update CLAUDE_PROJECT_DIR on `/cd`, so it can
					// name a vault subfolder (#263). Its commands start from the variable
					// and walk up to the vault root; the run test below proves they work.
					test(`${event} walks up from \${${envVar}:-.} to the vault root (#263)`, () => {
						assert.ok(
							command.includes(`r="\${${envVar}:-.}"`) && command.includes("vault-manifest.json") && command.includes(")/.claude/scripts/"),
							`${path} ${event} command must find the vault root from \${${envVar}:-.} — got:\n  ${command}`,
						);
					});
				} else {
					test(`${event} uses \${${envVar}:-.}/ prefix`, () => {
						assert.ok(
							command.includes(`\${${envVar}:-.}/.claude/scripts/`),
							`${path} ${event} command must resolve scripts via \${${envVar}:-.}/ to survive CWD drift — got:\n  ${command}`,
						);
					});
				}

				test(`${event} does not use a bare relative .claude/scripts/ path`, () => {
					// A bare relative path only survives if the invoking shell's
					// CWD is the project root — which is exactly the assumption
					// that broke in #45 for Claude Code, whose hooks inherit a tool
					// shell's `cd`. Codex's POSIX `command` keeps the prefix too; its
					// Windows form and Gemini's are relative by design (#268).
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
				/stop-checklist\.ts"?$/,
				`${path} must invoke stop-checklist.ts with no trailing arguments — its output contract is the same for every agent`,
			);
		});
	}
});

/**
 * #263: run every Claude hook command for real, with `node` replaced by a
 * shell function that prints its arguments, and check which script it would
 * run. Claude Code runs hook commands through a POSIX shell (Git Bash on
 * Windows), so this is the same shell, quoting and path handling, minus the
 * script itself. On macOS and Linux each command also runs under `sh`.
 */
describe("hook config — Claude commands find the vault root from a subfolder (#263)", () => {
	const commands = eachNodeHookCommand(loadConfig(".claude/settings.json"));
	const scriptOf = (command: string) => /\/\.claude\/scripts\/([a-z-]+\.ts)"$/.exec(command)?.[1] ?? "";

	test("every command walks up with the same text: one rule, five copies that cannot drift", () => {
		// JSON cannot share a snippet, so each command carries the walk-up. Each
		// copy is also run below, but only this keeps one copy from quietly
		// losing a branch (the fallback, say) that the run cases happen not to reach.
		const walkOf = (command: string) => command.slice(0, command.indexOf("/.claude/scripts/"));
		const walks = new Set(commands.map(({ command }) => walkOf(command)));
		assert.equal(commands.length, 5);
		assert.equal(walks.size, 1, `the walk-up differs between commands:\n${[...walks].join("\n")}`);
		assert.match([...walks][0]!, /vault-manifest\.json/);
	});

	/**
	 * The POSIX shells to run the commands under. On Windows that is Git Bash,
	 * the shell Claude Code itself uses there: never a bare `bash`, which can
	 * resolve to WSL's. None found means the run tests are skipped, with the
	 * reason in the skip, rather than failing on a missing binary.
	 */
	function posixShells(): string[] {
		if (process.platform !== "win32") return ["bash", "sh"].filter((sh) => spawnSync(sh, ["-c", "true"]).status === 0);
		const candidates = [
			process.env["CLAUDE_CODE_GIT_BASH_PATH"],
			process.env["ProgramFiles"] && join(process.env["ProgramFiles"], "Git", "bin", "bash.exe"),
			process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
			process.env["LOCALAPPDATA"] && join(process.env["LOCALAPPDATA"], "Programs", "Git", "bin", "bash.exe"),
		];
		const found = candidates.find((path): path is string => typeof path === "string" && existsSync(path));
		return found ? [found] : [];
	}
	const shells = posixShells();
	// Locally a missing shell skips with the reason. On CI it must fail instead:
	// a run that skips every command proves nothing and would still pass.
	const noShell = shells.length === 0 && !process.env["CI"] ? "no POSIX shell found (on Windows: Git Bash)" : false;

	/** The script path the command hands to node under `shell`, run from `cwd` with `env`. */
	function resolvedScript(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv): string {
		const run = spawnSync(shell, ["-c", `node() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf-8", cwd, env });
		assert.equal(run.status, 0, `${shell} failed: ${run.error?.message ?? run.stderr}`);
		return run.stdout.trim().split("\n").pop() ?? "";
	}
	const withProjectDir = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, CLAUDE_PROJECT_DIR: dir });
	const withoutProjectDir = (): NodeJS.ProcessEnv => {
		const env = { ...process.env };
		delete env["CLAUDE_PROJECT_DIR"];
		return env;
	};

	let vault = "";
	before(() => {
		vault = mkdtempSync(join(tmpdir(), "hook-config-vault-"));
		mkdirSync(join(vault, "work", "deep"), { recursive: true });
		writeFileSync(join(vault, "vault-manifest.json"), "{}");
	});
	after(() => rmSync(vault, { recursive: true, force: true }));

	// The "no vault above" case needs a temp folder that is not itself inside a vault.
	const tmpInVault = nearestVaultRoot(tmpdir()) !== null ? "the temp folder is inside a vault on this machine" : false;

	for (const shell of shells.length ? shells : ["(none)"]) {
		for (const { event, command } of commands) {
			const script = scriptOf(command);
			const label = `${event} under ${shell.split(/[\\/]/).pop()}`;

			test(`${label}: launched in a subfolder, the command runs the vault root's script`, { skip: noShell }, () => {
				assert.ok(script, `could not read the script name from: ${command}`);
				const got = resolvedScript(shell, command, vault, withProjectDir(join(vault, "work", "deep")));
				assert.equal(resolve(got), resolve(vault, ".claude", "scripts", script));
			});

			test(`${label}: with the variable unset, run from the vault root, the command still runs the root's script`, { skip: noShell }, () => {
				// Claude Code always sets the variable for hooks; unset is the
				// outside-Claude case, which keeps the pre-#263 `.` behaviour.
				const got = resolvedScript(shell, command, vault, withoutProjectDir());
				assert.equal(resolve(vault, got), resolve(vault, ".claude", "scripts", script));
			});

			test(`${label}: with no vault above, the command keeps the named folder`, { skip: noShell || tmpInVault }, () => {
				const elsewhere = mkdtempSync(join(tmpdir(), "hook-config-novault-"));
				try {
					const got = resolvedScript(shell, command, elsewhere, withProjectDir(elsewhere));
					assert.equal(resolve(got), resolve(elsewhere, ".claude", "scripts", script));
				} finally {
					rmSync(elsewhere, { recursive: true, force: true });
				}
			});
		}
	}
});

/** Codex's Windows-only override for each TS hook: `commandWindows` (#268). */
function eachCodexWindowsCommand(): Array<{ readonly event: string; readonly command: string; readonly windows: string | undefined }> {
	const out: Array<{ event: string; command: string; windows: string | undefined }> = [];
	for (const [event, entries] of Object.entries(loadConfig(".codex/hooks.json").hooks ?? {})) {
		for (const entry of entries) {
			for (const hook of entry.hooks ?? []) {
				if (hook.type !== "command" || typeof hook.command !== "string") continue;
				if (!hook.command.includes(".claude/scripts/")) continue;
				out.push({ event, command: hook.command, windows: hook.commandWindows });
			}
		}
	}
	return out;
}

/**
 * #268: on Windows neither Codex nor Gemini runs hook commands through a
 * POSIX shell, so `${X_PROJECT_DIR:-.}` reached Node unexpanded (cmd) or
 * collapsed to a drive-root path (PowerShell), and no hook ever ran.
 *
 * Codex documents `commandWindows` as a Windows-only override and runs every
 * hook in the session cwd, so its Windows form is relative and its POSIX
 * `command` is untouched. Gemini has no per-OS field: one command must work
 * under PowerShell (Windows) and bash (elsewhere), so it is relative on every
 * OS — identical to what `${GEMINI_PROJECT_DIR:-.}` meant, since Gemini sets
 * that variable to the same session cwd.
 */
describe("hook config — Codex has a Windows command for every TS hook (#268)", () => {
	for (const { event, command, windows } of eachCodexWindowsCommand()) {
		test(`${event}: commandWindows runs the same script by a relative path`, () => {
			const script = /\.claude\/scripts\/([a-z-]+\.ts)/.exec(command)?.[1];
			assert.ok(windows, `.codex/hooks.json ${event} has no commandWindows`);
			assert.equal(
				windows,
				`node --disable-warning=ExperimentalWarning --experimental-strip-types .claude/scripts/${script}`,
			);
		});
	}
});

/**
 * Run each command under the shell its agent really uses, from a vault root
 * whose scripts are stubs that print their name, and check the stub ran.
 *
 * - Gemini on Windows: exactly its runner's shape — `powershell.exe
 *   -NoProfile -Command "<cmd>; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"`.
 * - Codex on Windows: its hooks docs do not name the shell, so
 *   `commandWindows` must work under both cmd.exe and PowerShell.
 * - POSIX (and Git Bash): Gemini's command and Codex's `command` under bash.
 */
describe("hook config — Codex and Gemini commands run under their agents' shells (#268)", () => {
	const isWin = process.platform === "win32";
	const gemini = eachNodeHookCommand(loadConfig(".gemini/settings.json"));
	const codex = eachCodexWindowsCommand();
	const scripts = [...new Set([...gemini, ...codex].map(({ command }) => /\.claude\/scripts\/([a-z-]+\.ts)/.exec(command)?.[1] ?? ""))];

	let vault = "";
	before(() => {
		vault = mkdtempSync(join(tmpdir(), "hook-config-agents-"));
		mkdirSync(join(vault, ".claude", "scripts"), { recursive: true });
		writeFileSync(join(vault, "vault-manifest.json"), "{}");
		for (const s of scripts) writeFileSync(join(vault, ".claude", "scripts", s), `console.log("RAN ${s}");\n`);
	});
	after(() => rmSync(vault, { recursive: true, force: true }));

	const ran = (r: ReturnType<typeof spawnSync>, script: string) => {
		const out = `${r.stdout ?? ""}`;
		assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr ?? ""}${r.error?.message ?? ""}`);
		assert.ok(out.includes(`RAN ${script}`), `the stub did not run; stdout: ${out}`);
	};
	const scriptIn = (command: string) => /\.claude\/scripts\/([a-z-]+\.ts)/.exec(command)?.[1] ?? "";
	const powershell = (command: string) =>
		spawnSync("powershell.exe", ["-NoProfile", "-Command", `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`], {
			cwd: vault,
			encoding: "utf-8",
			env: { ...process.env, GEMINI_PROJECT_DIR: vault },
		});
	const cmdExe = (command: string) =>
		spawnSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd: vault, encoding: "utf-8", windowsVerbatimArguments: true });
	const bash = (command: string, env: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", command], { cwd: vault, encoding: "utf-8", env });
	const notWin = isWin ? false : "Windows only";
	// Neither agent uses bash on Windows, where a bare `bash` can also be WSL's.
	const noBash = isWin
		? "POSIX only: on Windows these agents run PowerShell or cmd"
		: spawnSync("bash", ["-c", "true"]).status === 0
			? false
			: "no bash on this machine";

	for (const { event, command } of gemini) {
		test(`Gemini ${event} under PowerShell, as Gemini runs it on Windows`, { skip: notWin }, () => {
			ran(powershell(command), scriptIn(command));
		});
		test(`Gemini ${event} under bash, as Gemini runs it elsewhere`, { skip: noBash }, () => {
			ran(bash(command, { ...process.env, GEMINI_PROJECT_DIR: vault }), scriptIn(command));
		});
	}
	for (const { event, command, windows } of codex) {
		test(`Codex ${event} commandWindows under cmd.exe`, { skip: notWin }, () => {
			ran(cmdExe(windows ?? ""), scriptIn(command));
		});
		test(`Codex ${event} commandWindows under PowerShell`, { skip: notWin }, () => {
			ran(powershell(windows ?? ""), scriptIn(command));
		});
		test(`Codex ${event} command under bash (POSIX, unchanged)`, { skip: noBash }, () => {
			const env = { ...process.env };
			delete env["CODEX_PROJECT_DIR"];
			ran(bash(command, env), scriptIn(command));
		});
	}
});
