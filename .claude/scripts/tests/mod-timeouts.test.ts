/**
 * The obsidian-mind mod runs the vault's hook scripts itself, with a timeout
 * for each (.claude/skills/obsidian-mind/hooks/register.ts). Each must equal
 * the timeout settings.json gives the same script as a hook, so the mod never
 * waits longer, or gives up sooner, than the hook it replaces would.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const REGISTER = join(REPO, ".claude/skills/obsidian-mind/hooks/register.ts");

/** Each script the mod runs, with the timeout it passes, in milliseconds. */
export function modTimeouts(source: string): Map<string, number> {
	const found = new Map<string, number>();
	for (const m of source.matchAll(/runScript\(\$, root, "([\w-]+\.ts)", [^;]*?, ([\d_]+)\)/g)) {
		found.set(m[1]!, Number(m[2]!.replace(/_/g, "")));
	}
	return found;
}

/** The timeout settings.json gives the Claude hook that runs `script`, in milliseconds. */
function settingsTimeout(script: string): number | undefined {
	const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf-8")) as {
		hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
	};
	for (const groups of Object.values(settings.hooks)) {
		for (const hook of groups.flatMap((g) => g.hooks)) {
			if (hook.command.includes(`/.claude/scripts/${script}`) && hook.timeout !== undefined) return hook.timeout * 1000;
		}
	}
	return undefined;
}

describe("the mod's script timeouts", () => {
	test("the reader finds every script the mod runs", () => {
		const found = modTimeouts(readFileSync(REGISTER, "utf-8"));
		assert.deepEqual([...found.keys()].sort(), ["session-start.ts", "stop-checklist.ts"]);
	});

	test("each equals the timeout settings.json gives the same script", () => {
		for (const [script, ms] of modTimeouts(readFileSync(REGISTER, "utf-8"))) {
			assert.equal(ms, settingsTimeout(script), `${script}: the mod waits ${ms} ms`);
		}
	});
});
