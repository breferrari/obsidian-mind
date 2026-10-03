import type { test } from "claude-code/testing";

// The engine and the vault beneath the mod, for the plugin tests. Each test's
// `on` hooks sit below the mod; these stand in for the host's calls and for
// the settings hooks the mod passes events down to. Shared by every suite, so
// a change to the host's reply shapes is made in one place.

/** The `on` a plugin test receives. */
export type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1];

/** What a vault script prints, as `process.run` reports it. */
export type Reply = { exitCode: number; stdout: string; stderr?: string };

export const ROOT = "/vault";

export type World = {
	/** Each script the mod ran: its argv and init (cwd, env, stdin). */
	runs: Array<{ argv: readonly string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string } }>;
	/** Each settings-hook event the mod passed down, by event name. */
	passedDown: Record<"SessionStart", Array<Record<string, unknown>>>;
	writes: Array<{ path: string; text: string }>;
	invalidated: string[];
};

/**
 * Stub the host beneath the mod. `reply` answers each `process.run`; a call
 * on `$` is answered `{ value }`. `hangFirstWrite` makes the first `fs.write`
 * never settle, to prove delivery does not wait on it.
 */
export function engine(on: On, reply: () => Reply, options: { hangFirstWrite?: boolean } = {}): World {
	const world: World = { runs: [], passedDown: { SessionStart: [] }, writes: [], invalidated: [] };
	on("session.root", () => ({ value: ROOT }));
	on("process.run", (_$, e) => {
		world.runs.push(e as World["runs"][number]);
		const { exitCode, stdout, stderr = "" } = reply();
		return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } };
	});
	on("fs.write", (_$, e) => {
		world.writes.push(e);
		if (options.hangFirstWrite && world.writes.length === 1) return new Promise<never>(() => {});
		return { value: undefined };
	});
	on("ui.invalidate", (_$, e) => {
		world.invalidated.push(e.event);
		return { value: undefined };
	});
	on("classic.SessionStart", (_$, e) => {
		world.passedDown.SessionStart.push(e as unknown as Record<string, unknown>);
		return {};
	});
	return world;
}
