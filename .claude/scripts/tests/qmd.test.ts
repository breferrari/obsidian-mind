/**
 * Tests for the shared cross-platform qmd spawn helpers.
 *
 * Paired with `tests/qmd-mcp.test.ts` — the MCP wrapper duplicates this
 * logic in .mjs (because .ts imports don't flow from .mjs at strip-types
 * runtime). Both copies are exercised in the CI matrix so drift between
 * them surfaces as a test failure rather than a silent platform bug.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
	buildQmdCommand,
	isRunnableQmdEntry,
	npmGlobalRoot as npmGlobalRootTs,
	parseVersionTriple,
	pickQmdEntry,
	qmdVersionAtLeast,
	resolveQmdEntry,
} from "../lib/qmd.ts";
import {
	isRunnableQmdEntry as isRunnableQmdEntryMjs,
	npmGlobalRoot as npmGlobalRootMjs,
	pickQmdEntry as pickQmdEntryMjs,
} from "../qmd-mcp.mjs";

/**
 * A present-but-broken install used to win just by existing: the first
 * candidate that resolved was returned, so a broken local copy shadowed a
 * working global one. Both copies of the picker run the same cases.
 */
for (const [label, pick, isRunnable] of [
	["lib/qmd.ts", pickQmdEntry, isRunnableQmdEntry],
	["qmd-mcp.mjs", pickQmdEntryMjs, isRunnableQmdEntryMjs],
] as const) {
	describe(`${label} pickQmdEntry`, () => {
		const probe = (ok: ReadonlySet<string>) => {
			const probed: string[] = [];
			return {
				probed,
				runnable: (e: string) => {
					probed.push(e);
					return ok.has(e);
				},
			};
		};

		test("a broken first candidate does not shadow a runnable second", () => {
			const p = probe(new Set(["global"]));
			assert.equal(pick([() => "local", () => "global"], p.runnable), "global");
		});

		test("every candidate broken → the first present, so the ABI self-heal still has a package", () => {
			const p = probe(new Set());
			assert.equal(pick([() => "local", () => "global"], p.runnable), "local");
		});

		test("nothing present → null", () => {
			const p = probe(new Set());
			assert.equal(pick([() => null, () => null], p.runnable), null);
			assert.deepEqual(p.probed, []);
		});

		test("a lone candidate is returned without a probe", () => {
			const p = probe(new Set());
			assert.equal(pick([() => null, () => "global"], p.runnable), "global");
			assert.deepEqual(p.probed, []);
		});

		test("a runnable first candidate skips the later lookups", () => {
			const p = probe(new Set(["local"]));
			let looked = false;
			const later = () => {
				looked = true;
				return "global";
			};
			assert.equal(pick([() => "local", later], p.runnable), "local");
			assert.equal(looked, false);
		});
	});

	describe(`${label} isRunnableQmdEntry`, () => {
		test("an entry that exits 0 is runnable; one that throws on load is not", () => {
			const dir = mkdtempSync(join(tmpdir(), "qmd-probe-"));
			try {
				const good = join(dir, "good.mjs");
				const bad = join(dir, "bad.mjs");
				writeFileSync(good, "process.stdout.write('qmd 9.9.9\\n');\n");
				writeFileSync(bad, "throw new Error('Cannot find module better-sqlite3');\n");
				assert.equal(isRunnable(good), true);
				assert.equal(isRunnable(bad), false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
}

describe("lib/qmd.resolveQmdEntry", () => {
	test("returns an absolute path to an existing qmd entrypoint when qmd is installed", () => {
		const entry = resolveQmdEntry();

		// When qmd isn't on this machine, the resolver must cleanly return null
		// — the assertion below is meaningful only against a real install.
		// CI installs qmd globally, so the positive branch runs on every
		// matrix leg.
		if (entry === null) {
			assert.ok(
				true,
				"qmd not installed in this environment — resolver correctly returned null",
			);
			return;
		}

		assert.equal(typeof entry, "string");
		assert.equal(
			isAbsolute(entry),
			true,
			`resolved path must be absolute, got: ${entry}`,
		);
		assert.equal(
			existsSync(entry),
			true,
			`resolved path must exist on disk, got: ${entry}`,
		);
		assert.match(
			entry,
			/@tobilu[\\/]qmd[\\/]dist[\\/]cli[\\/]qmd\.js$/,
			`resolved path should point at @tobilu/qmd's CLI entry, got: ${entry}`,
		);
	});
});

describe("lib/qmd.buildQmdCommand", () => {
	test("routes through process.execPath when an entrypoint is resolved", () => {
		const out = buildQmdCommand("/fake/qmd.js", ["update"]);
		assert.equal(out.cmd, process.execPath);
		assert.deepEqual(out.args, ["/fake/qmd.js", "update"]);
		assert.equal(out.shell, false);
	});

	test("forwards multi-arg subcommands", () => {
		const out = buildQmdCommand("/fake/qmd.js", [
			"--index",
			"vault-a",
			"query",
			"hello",
		]);
		assert.deepEqual(out.args, [
			"/fake/qmd.js",
			"--index",
			"vault-a",
			"query",
			"hello",
		]);
	});

	test("falls back to a single-string shell command when resolution returns null", () => {
		// Single-string command with shell:true (not args+shell) so Node 24
		// doesn't fire DEP0190 about unescaped concatenation. Args fold into
		// the command string at build time so callers never reintroduce the
		// deprecated pattern at the spawn site.
		const out = buildQmdCommand(null, ["update"]);
		assert.equal(out.cmd, "qmd update");
		assert.deepEqual(out.args, []);
		assert.equal(out.shell, true);
	});

	test("fallback folds multi-arg subcommands into the single command string", () => {
		const out = buildQmdCommand(null, ["--index", "vault-a", "embed"]);
		assert.equal(out.cmd, "qmd --index vault-a embed");
		assert.deepEqual(out.args, []);
	});

	test("fallback args array is always empty (single-string contract)", () => {
		const input = ["update"];
		const out = buildQmdCommand(null, input);
		assert.deepEqual(out.args, []);
		// And the returned args is its own array, not aliased to the input.
		assert.notEqual(out.args, input);
	});
});

describe("parseVersionTriple", () => {
	test("parses bare x.y.z", () => {
		assert.deepEqual(parseVersionTriple("2.5.3"), [2, 5, 3]);
	});
	test("parses the qmd --version output shape", () => {
		assert.deepEqual(parseVersionTriple("qmd 2.5.3 (655769712a)"), [2, 5, 3]);
	});
	test("null when no triple present", () => {
		assert.equal(parseVersionTriple("qmd dev-build"), null);
		assert.equal(parseVersionTriple(""), null);
		assert.equal(parseVersionTriple("2.5"), null);
	});
});

describe("qmdVersionAtLeast", () => {
	test("true when equal or above", () => {
		assert.equal(qmdVersionAtLeast("qmd 2.5.3 (abc)", "2.5.3"), true);
		assert.equal(qmdVersionAtLeast("qmd 2.5.3 (abc)", "2.0.0"), true);
		assert.equal(qmdVersionAtLeast("3.0.0", "2.9.9"), true);
	});
	test("false when below on any component", () => {
		assert.equal(qmdVersionAtLeast("qmd 1.9.9 (abc)", "2.0.0"), false);
		assert.equal(qmdVersionAtLeast("2.4.9", "2.5.0"), false);
		assert.equal(qmdVersionAtLeast("2.5.2", "2.5.3"), false);
	});
	test("fails open on unparseable input, either side", () => {
		assert.equal(qmdVersionAtLeast("qmd dev-build", "2.0.0"), true);
		assert.equal(qmdVersionAtLeast("2.5.3", "latest"), true);
	});
});

/**
 * Where npm keeps global packages, without spawning npm (#349). Both copies
 * of the resolver run the same cases; the last asks the real npm on this
 * machine and must agree with it.
 */
/** The real npm's answer on this machine, asked at most once for both copies; null without npm. */
let npmAsked: string | null | undefined;
const npmAnswer = (): string | null => {
	if (npmAsked === undefined) {
		const npm = spawnSync("npm root -g", { shell: true, encoding: "utf8", timeout: 15_000 });
		const asked = (npm.stdout ?? "").trim();
		npmAsked = npm.status === 0 && asked !== "" ? asked : null;
	}
	return npmAsked;
};

for (const [label, npmGlobalRoot] of [
	["lib/qmd.ts", npmGlobalRootTs],
	["qmd-mcp.mjs", npmGlobalRootMjs],
] as const) {
	describe(`${label} npmGlobalRoot`, () => {
		const home = join(tmpdir(), "home");
		const nodeDir = join(tmpdir(), "nodejs");
		const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;
		const win = (env: Record<string, string> = {}, text: Record<string, string> = {}) =>
			npmGlobalRoot({ env, platform: "win32", execPath: join(nodeDir, "node.exe"), home, readText: files(text) });
		const posix = (env: Record<string, string> = {}, text: Record<string, string> = {}) =>
			npmGlobalRoot({ env, platform: "linux", execPath: join(nodeDir, "bin", "node"), home, readText: files(text) });

		test("nothing configured: Node's own prefix, laid out per platform", () => {
			assert.equal(win(), join(nodeDir, "node_modules"));
			assert.equal(posix(), join(nodeDir, "lib", "node_modules"));
		});

		test("the Windows installer's builtin npmrc, with its ${APPDATA}", () => {
			const builtin = join(nodeDir, "node_modules", "npm", "npmrc");
			const appdata = join(tmpdir(), "Roaming");
			assert.equal(
				win({ APPDATA: appdata }, { [builtin]: String.raw`prefix=${"${APPDATA}"}\npm` + "\n" }),
				join(String.raw`${appdata}\npm`, "node_modules"),
			);
		});

		test("the user npmrc beats the builtin, quoted, among other keys", () => {
			const builtin = join(nodeDir, "lib", "node_modules", "npm", "npmrc");
			const mine = join(tmpdir(), "mine");
			assert.equal(
				posix({}, { [builtin]: "prefix=/usr/local\n", [join(home, ".npmrc")]: `; comment\nregistry=https://example.com/\r\nprefix = "${mine}"\n` }),
				join(mine, "lib", "node_modules"),
			);
		});

		test("npm_config_userconfig and npm_config_globalconfig name the files read", () => {
			const user = join(tmpdir(), "u.npmrc");
			const global = join(tmpdir(), "g.npmrc");
			const a = join(tmpdir(), "a");
			const b = join(tmpdir(), "b");
			assert.equal(posix({ npm_config_userconfig: user }, { [user]: `prefix=${a}` }), join(a, "lib", "node_modules"));
			assert.equal(posix({ npm_config_globalconfig: global }, { [global]: `prefix=${b}` }), join(b, "lib", "node_modules"));
		});

		test("the environment beats every npmrc, in either case", () => {
			const env = join(tmpdir(), "env-prefix");
			const npmrc = { [join(home, ".npmrc")]: "prefix=/elsewhere" };
			assert.equal(win({ npm_config_prefix: env }, npmrc), join(env, "node_modules"));
			assert.equal(posix({ NPM_CONFIG_PREFIX: env }, npmrc), join(env, "lib", "node_modules"));
		});

		test("a leading ~ in an npmrc prefix is home, as npm reads it", () => {
			assert.equal(posix({}, { [join(home, ".npmrc")]: "prefix=~/.npm-global" }), join(home, ".npm-global", "lib", "node_modules"));
		});

		test("a setting it can't work out exactly gives null, never a lower setting", () => {
			const user = { [join(home, ".npmrc")]: `prefix=${join(tmpdir(), "user")}` };
			// npm keeps an unset ${VAR} literally; a relative prefix would anchor at the cwd.
			assert.equal(posix({ npm_config_prefix: "relative/dir" }, user), null);
			assert.equal(posix({}, { [join(home, ".npmrc")]: "prefix=${NO_SUCH_VAR}/npm" }), null);
			assert.equal(posix({ npm_config_userconfig: "~not-home" }), null);
		});

		test("an npmrc is read as npm reads it: the last top-level prefix, no section keys, comments stripped", () => {
			const a = join(tmpdir(), "a");
			const b = join(tmpdir(), "b");
			assert.equal(
				posix({}, { [join(home, ".npmrc")]: `prefix=${a}\nprefix=${b} ; moved\n[sub]\nprefix=/ignored\n` }),
				join(b, "lib", "node_modules"),
			);
		});

		test("home is $HOME before the OS home, and a user npmrc may name the global npmrc", () => {
			const h = join(tmpdir(), "h");
			const g = join(tmpdir(), "custom-global");
			const c = join(tmpdir(), "c");
			const root = npmGlobalRoot({
				env: { HOME: h },
				platform: "linux",
				execPath: join(nodeDir, "bin", "node"),
				readText: files({ [join(h, ".npmrc")]: `globalconfig=${g}`, [g]: `prefix=${c}` }),
			});
			assert.equal(root, join(c, "lib", "node_modules"));
		});

		test("Node's own prefix honours PREFIX, and DESTDIR on POSIX", () => {
			const p = join(tmpdir(), "p");
			assert.equal(posix({ PREFIX: p }), join(p, "lib", "node_modules"));
			assert.equal(win({ PREFIX: p }), join(p, "node_modules"));
			assert.equal(posix({ DESTDIR: join(tmpdir(), "dest") }), join(tmpdir(), "dest", nodeDir, "lib", "node_modules"));
		});

		test("npm_config_ is matched in any case", () => {
			const env = join(tmpdir(), "mixed");
			assert.equal(posix({ Npm_Config_Prefix: env }), join(env, "lib", "node_modules"));
		});

		// The property that matters: a root this works out and finds qmd under is
		// the root npm itself would give. A miss (Homebrew's builtin npmrc lives
		// outside Node's prefix, say) only costs the spawn.
		test("where it finds qmd on this machine, npm agrees", (t) => {
			const ours = npmGlobalRoot();
			if (ours === null || !existsSync(join(ours, "@tobilu", "qmd", "dist", "cli", "qmd.js"))) {
				return t.skip("no qmd under the worked-out root here; the caller asks npm");
			}
			const answer = npmAnswer();
			if (answer === null) return t.skip("npm is not available here");
			assert.equal(resolve(ours).toLowerCase(), resolve(answer).toLowerCase());
		});
	});
}
