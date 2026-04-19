/**
 * Shared helpers for hook-entry integration tests.
 *
 * runScript spawns the hook entry point the same way settings.json does:
 * `node --experimental-strip-types <script>` with JSON on stdin. Used by
 * classify-message.test.ts and validate-write.test.ts to exercise the
 * full stdin → stdout pipeline under the real runtime.
 */

import { spawnSync } from "node:child_process";

export type RunResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
};

export function runScript(
	scriptPath: string,
	stdin: string | object | null,
	envOverrides?: Readonly<Record<string, string>>,
): RunResult {
	const input =
		stdin === null
			? ""
			: typeof stdin === "string"
				? stdin
				: JSON.stringify(stdin);
	const proc = spawnSync(
		process.execPath,
		["--experimental-strip-types", scriptPath],
		{
			input,
			encoding: "utf-8",
			timeout: 10_000,
			env: envOverrides
				? { ...process.env, ...envOverrides }
				: process.env,
		},
	);
	return {
		stdout: proc.stdout ?? "",
		stderr: proc.stderr ?? "",
		code: proc.status ?? -1,
	};
}
