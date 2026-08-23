/**
 * Shared helpers for hook-entry integration tests.
 *
 * runScript spawns the hook entry point the same way settings.json does:
 * `node --disable-warning=ExperimentalWarning --experimental-strip-types
 * <script>` with JSON on stdin. The disable-warning flag mirrors the
 * production hook command exactly so stderr-cleanliness assertions don't
 * trip on Node's type-stripping warning (which is unrelated to the hook
 * under test). Used by classify-message.test.ts and validate-write.test.ts
 * to exercise the full stdin → stdout pipeline under the real runtime.
 *
 * hostPath normalizes POSIX-style literal test paths (e.g. `"/Users/x/foo"`)
 * to the host platform via path.resolve. Needed on Windows, where the raw
 * string is treated as drive-relative and pathToFileURL prepends the current
 * drive letter — so a round trip stops matching the literal argv[1] value.
 *
 * rmTemp and waitFor exist because both CI flakes in #235 were assumptions
 * about timing rather than defects in what was under test: a cleanup that
 * cannot delete a temp tree, and a fixed sleep standing in for a condition.
 * Both shapes recur across suites, so the reasoning lives here once.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

export function hostPath(literal: string): string {
	return resolve(literal);
}

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
		[
			"--disable-warning=ExperimentalWarning",
			"--experimental-strip-types",
			scriptPath,
		],
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

/**
 * Temp trees this could not remove, deduplicated, in the order they failed.
 *
 * Module state rather than a return value because the callers are `after` and
 * `finally` hooks: none of them is in a position to do anything with an error,
 * which is the whole reason the throw was removed.
 */
const leaked: { readonly dir: string; readonly code: string }[] = [];

/**
 * What {@link rmTemp} has failed to remove so far, as a snapshot.
 *
 * Exported so the recording is assertable. A swallow that nothing can observe
 * is the thing this file is trying not to be, and a test proving the swallow
 * happens is not the same as a test proving it was *counted*.
 */
export function leakedTempDirs(): readonly { readonly dir: string; readonly code: string }[] {
	return leaked.slice();
}

/**
 * Remove a temp tree, and never fail the run for not managing it.
 *
 * Cleanup is not the assertion. A temp directory that survives is residue in
 * the OS temp dir, which the OS reclaims; a throw here turns that cosmetic
 * problem into a red build — and does so on Windows, where a handle held open
 * a moment longer than expected is ordinary rather than exceptional. #235
 * lost a passing suite to exactly that, `EPERM` out of an `after` hook.
 *
 * Retries first, because a handle race usually clears in milliseconds, then
 * gives up **loudly**. A test that needs the removal to have SUCCEEDED must
 * assert on it, not rely on this throwing.
 *
 * **The report is the point of the swallow being acceptable at all.** Before
 * this, a held handle turned CI red: a bad test result, and also a real signal
 * that something outlives the suite. Silently swallowing it keeps the build
 * honest and takes the signal away, leaving the open question of what holds the
 * handle on Windows with nothing feeding it. So the failure is recorded and
 * announced at exit instead: green stays green, and the handle holder keeps
 * naming itself until someone fixes it properly.
 *
 * The `errno` code travels with the path because that is the question the
 * report exists to answer. `EPERM` and `EBUSY` mean a live handle; `EACCES`
 * means permissions and is a different bug with a different owner.
 */
export function rmTemp(dir: string | null | undefined): void {
	if (!dir) return;
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (e) {
		const code = (e as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
		// Deduplicated so the count means "how many trees survived" rather than
		// "how many times we tried", which is what a reader will take it for.
		if (!leaked.some((l) => l.dir === dir)) leaked.push({ dir, code });
	}
}

// One handler per process, because a module is a singleton and the test runner
// gives each file its own process — so each file reports its own residue.
//
// stderr rather than stdout: this is diagnostic output about the run, not a
// result of it, and `runScript` captures the stderr of the *spawned hook*
// rather than the runner's, so nothing that asserts stderr cleanliness can see
// this line.
process.on("exit", () => {
	if (leaked.length === 0) return;
	console.error(`rmTemp: ${leaked.length} temp dir(s) survived cleanup:`);
	for (const { dir, code } of leaked) console.error(`  ${code}  ${dir}`);
});

/**
 * Wait until `condition` holds, or until the deadline passes.
 *
 * Returns rather than throws, so the caller's own assertion reports the
 * failure: `await waitFor(() => !c.alive)` followed by the existing
 * `assert.equal(c.alive, false, ...)` still fails when the client never dies,
 * and fails with the message the test already wrote.
 *
 * This replaces `await new Promise((r) => setTimeout(r, 400))`, which is a bet
 * on how long an async signal takes — too short and it flakes on a loaded
 * runner (#235), too long and every green run pays for it. Polling is fast
 * when the signal is fast and patient when it is not.
 */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
	intervalMs = 25,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
