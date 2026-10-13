/**
 * reindexSync after a write over MCP: the synchronous `update` that makes the
 * note retrievable, and the detached `embed` that only ranks it. Under
 * VAULT_QMD_REFRESH=off, which every test process carries, the embed is not
 * spawned: a suite leaves no qmd work behind (#337, #347).
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { reindexSync } from "../lib/mcp-server.ts";
import { REFRESH_SWITCH } from "../lib/qmd-refresh.ts";

/** Run `fn` with the switch and HOOK_DEBUG set as given, capturing stderr. */
function withEnv<T>(refreshSwitch: string | undefined, fn: () => T): { result: T; stderr: string } {
	const setEnv = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	const before = { sw: process.env[REFRESH_SWITCH], dbg: process.env["HOOK_DEBUG"] };
	setEnv(REFRESH_SWITCH, refreshSwitch);
	setEnv("HOOK_DEBUG", "1");
	let stderr = "";
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
	try {
		return { result: fn(), stderr };
	} finally {
		process.stderr.write = write;
		setEnv(REFRESH_SWITCH, before.sw);
		setEnv("HOOK_DEBUG", before.dbg);
	}
}

describe("reindexSync — the detached embed honours VAULT_QMD_REFRESH (#347)", () => {
	const ran: string[] = [];
	const run = (ok: boolean) => (sub: string) => (ran.push(sub), ok);
	afterEach(() => {
		ran.length = 0;
	});

	test("under VAULT_QMD_REFRESH=off, reindexSync indexes but spawns no embed", () => {
		const { result, stderr } = withEnv("off", () => reindexSync("om-test", { run: run(true) }));
		assert.equal(result, true, "the note is retrievable: update ran and succeeded");
		assert.deepEqual(ran, ["update"]);
		assert.match(stderr, /om-mcp: qmd refresh off \(VAULT_QMD_REFRESH=off\); nothing spawned/);
	});

	test("with the switch unset, a successful update spawns exactly one embed, with the index name", () => {
		const spawned: (readonly string[])[] = [];
		const { result } = withEnv(undefined, () =>
			reindexSync("om-test", { run: run(true), spawnEmbed: (args) => spawned.push(args) }),
		);
		assert.equal(result, true);
		assert.deepEqual(spawned, [["--index", "om-test", "embed"]]);
	});

	test("a failed update spawns no embed, and returns false", () => {
		const spawned: (readonly string[])[] = [];
		const { result } = withEnv(undefined, () =>
			reindexSync("om-test", { run: run(false), spawnEmbed: (args) => spawned.push(args) }),
		);
		assert.equal(result, false);
		assert.deepEqual(spawned, []);
	});
});
