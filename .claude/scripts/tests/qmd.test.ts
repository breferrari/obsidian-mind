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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
	buildQmdCommand,
	globalQmdEntry as globalQmdEntryTs,
	isRunnableQmdEntry,
	npmGlobalRoot as npmGlobalRootTs,
	parseVersionTriple,
	pickQmdEntry,
	qmdVersionAtLeast,
	resolveQmdEntry,
} from "../lib/qmd.ts";
import {
	globalQmdEntry as globalQmdEntryMjs,
	isRunnableQmdEntry as isRunnableQmdEntryMjs,
	npmGlobalRoot as npmGlobalRootMjs,
	pickQmdEntry as pickQmdEntryMjs,
} from "../qmd-mcp.mjs";
import { rmTemp } from "./_helpers.ts";

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

// Where npm keeps global packages, without spawning npm (#349): only the
// cheap exact cases npmGlobalRoot's doc lists, and null (ask npm) for the
// rest. Both copies of the resolver run the same cases; the last checks the
// real npm on this machine.

/** qmd's entry, relative to a global root. */
const QMD_ENTRY = join("@tobilu", "qmd", "dist", "cli", "qmd.js");

/** This process's env without the npm_config_* that `npm test` exports. */
const withoutNpmConfig = (): Record<string, string | undefined> =>
	Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)));

/** The real npm's answer on this machine, asked at most once for both copies; null without npm. */
let npmAsked: string | null | undefined;
const npmAnswer = (): string | null => {
	if (npmAsked === undefined) {
		const npm = spawnSync("npm root -g", { shell: true, encoding: "utf8", timeout: 15_000, env: withoutNpmConfig() });
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
		const winNpm = join(nodeDir, "node_modules", "npm");
		const posixNpm = join(nodeDir, "lib", "node_modules", "npm");
		// npm sits beside this Node unless a test says otherwise.
		const npmBeside = { [join(winNpm, "package.json")]: "{}", [join(posixNpm, "package.json")]: "{}" };
		const files = (map: Record<string, string>) => (path: string) => ({ ...npmBeside, ...map })[path] ?? null;
		const win = (env: Record<string, string> = {}, text: Record<string, string> = {}) =>
			npmGlobalRoot({ env, platform: "win32", execPath: join(nodeDir, "node.exe"), home, readText: files(text) });
		const posix = (env: Record<string, string> = {}, text: Record<string, string> = {}) =>
			npmGlobalRoot({ env, platform: "linux", execPath: join(nodeDir, "bin", "node"), home, readText: files(text) });
		const winBuiltin = join(winNpm, "npmrc");
		const posixBuiltin = join(posixNpm, "npmrc");
		const userNpmrc = join(home, ".npmrc");

		test("5: nothing configured is Node's own prefix, laid out per platform", () => {
			assert.equal(win(), join(nodeDir, "node_modules"));
			assert.equal(posix(), join(nodeDir, "lib", "node_modules"));
		});

		test("1: npm_config_prefix in the env, in any case, beats every npmrc", () => {
			const p = join(tmpdir(), "env-prefix");
			const npmrc = { [userNpmrc]: "prefix=/elsewhere" };
			assert.equal(win({ npm_config_prefix: p }, npmrc), join(p, "node_modules"));
			assert.equal(posix({ NPM_CONFIG_PREFIX: p }, npmrc), join(p, "lib", "node_modules"));
			assert.equal(posix({ Npm_Config_Prefix: p }), join(p, "lib", "node_modules"));
		});

		test("1: an env prefix that isn't absolute, or holds ${, asks npm", () => {
			assert.equal(posix({ npm_config_prefix: "relative/dir" }), null);
			assert.equal(posix({ npm_config_prefix: join(tmpdir(), "${NAME}") }), null);
		});

		test("1: env values are read as npm reads them: empty skipped, the last winning, nothing trimmed", () => {
			const a = join(tmpdir(), "a");
			const b = join(tmpdir(), "b");
			// npm's loadEnv skips only "" and keeps the value as given (@npmcli/config, npm 10.9.2, read 2026-10-14).
			assert.equal(posix({ npm_config_prefix: `${a} ` }), null, "padded: npm doesn't trim it, so ask npm");
			assert.equal(posix({ npm_config_prefix: " " }), null, "whitespace is set for npm, not unset");
			assert.equal(posix({ npm_config_userconfig: " " }), null);
			assert.equal(posix({ npm_config_prefix: "" }), join(nodeDir, "lib", "node_modules"), "empty is unset");
			assert.equal(posix({ npm_config_prefix: a, NPM_CONFIG_PREFIX: b }), join(b, "lib", "node_modules"));
		});

		test("1: on a Windows host, a drive-relative prefix asks npm", { skip: process.platform !== "win32" }, () => {
			assert.equal(win({ npm_config_prefix: "\\npm" }), null);
			assert.equal(win({ npm_config_prefix: "/npm" }), null);
		});

		test("2: PREFIX, DESTDIR, npm_config_userconfig or npm_config_globalconfig set asks npm", () => {
			for (const key of ["PREFIX", "DESTDIR", "npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG"]) {
				assert.equal(posix({ [key]: join(tmpdir(), "x") }), null, key);
			}
		});

		test("3: a user or global npmrc that mentions prefix or globalconfig, sections included, asks npm", () => {
			assert.equal(posix({}, { [userNpmrc]: "prefix=/opt/npm" }), null);
			assert.equal(posix({}, { [userNpmrc]: "[project]\nprefix = /opt/npm" }), null);
			assert.equal(posix({}, { [userNpmrc]: `globalconfig=${join(tmpdir(), "g")}` }), null);
			assert.equal(posix({}, { [join(nodeDir, "etc", "npmrc")]: "prefix=/opt/npm" }), null);
			assert.equal(win({}, { [join(nodeDir, "etc", "npmrc")]: "prefix=C:\\npm" }), null);
		});

		test("3: an npmrc with only auth, registry or save-prefix lines doesn't count", () => {
			const auth = {
				[userNpmrc]:
					"registry=https://registry.example.com/\n//registry.example.com/:_authToken=abc\nsave-prefix=~\n; prefix=/commented\n# ${NPMKEY}=/commented\n",
			};
			assert.equal(posix({}, auth), join(nodeDir, "lib", "node_modules"));
		});

		test("3 and 4: a quoted key asks npm: npm's ini unquotes keys", () => {
			assert.equal(posix({}, { [userNpmrc]: '"prefix" = /opt/npm' }), null);
			assert.equal(posix({}, { [userNpmrc]: "'globalconfig'=/opt/g" }), null);
			assert.equal(posix({}, { [userNpmrc]: '"pre\\u0066ix"=/opt/npm' }), null, "escapes too");
			assert.equal(posix({}, { [posixBuiltin]: '"prefix"=/opt/homebrew' }), null);
		});

		test("3: a home the OS can't name (a UID with no passwd entry) asks npm instead of throwing", () => {
			const noHome = () => {
				throw new Error("uv_os_homedir returned ENOENT");
			};
			const at = (env: Record<string, string>) =>
				npmGlobalRoot({ env, platform: "linux", execPath: join(nodeDir, "bin", "node"), readText: files({}), osHome: noHome });
			assert.equal(at({}), null);
			const p = join(tmpdir(), "env-prefix");
			assert.equal(at({ NPM_CONFIG_PREFIX: p }), join(p, "lib", "node_modules"), "rule 1 needs no home");
		});

		test("3: auth keys with %, ~ or + are plain, not a reason to ask npm", () => {
			const auth = { [userNpmrc]: "//registry.corp/npm/%40team/:_authToken=x\n//host/~user/:_auth=y\n//h/a+b/:always-auth=true" };
			assert.equal(posix({}, auth), join(nodeDir, "lib", "node_modules"));
		});

		test("3: a key ini would cut or reshape asks npm: ; or #, brackets, a backslash, inner whitespace", () => {
			for (const line of ["prefix#moved=/opt/g", "globalconfig;x=/etc/g", "prefix[]=/opt/g", "pre\\fix=/opt/g", "pre fix=/opt/g"]) {
				assert.equal(posix({}, { [userNpmrc]: line }), null, line);
			}
		});

		test("3: a key npm would build from ${...} asks npm", () => {
			assert.equal(posix({}, { [userNpmrc]: "${NPMKEY}=/opt/g" }), null);
		});

		test("3: HOME is read before the OS home", () => {
			const h = join(tmpdir(), "h");
			const at = (text: Record<string, string>) =>
				npmGlobalRoot({ env: { HOME: h }, platform: "linux", execPath: join(nodeDir, "bin", "node"), readText: files(text) });
			assert.equal(at({ [join(h, ".npmrc")]: "prefix=/opt/npm" }), null);
			assert.equal(at({}), join(nodeDir, "lib", "node_modules"));
		});

		test("4: the Windows installer's builtin npmrc is %APPDATA%\\npm, comments and blank lines aside", () => {
			const appdata = join(tmpdir(), "Roaming");
			assert.equal(
				win({ APPDATA: appdata }, { [winBuiltin]: "; installer default\n\nprefix=${APPDATA}\\npm\n" }),
				join(appdata, "npm", "node_modules"),
			);
		});

		test("4: anything else in the builtin npmrc asks npm", () => {
			const appdata = join(tmpdir(), "Roaming");
			assert.equal(win({ APPDATA: appdata }, { [winBuiltin]: "prefix=C:\\npm\\prefix" }), null);
			assert.equal(win({}, { [winBuiltin]: "prefix=${APPDATA}\\npm" }), null, "no APPDATA to expand");
			assert.equal(
				win({ APPDATA: appdata }, { [winBuiltin]: "prefix=${APPDATA}\\npm\nuserconfig=D:\\cfg\\npmrc" }),
				null,
				"another setting beside the installer's line",
			);
			assert.equal(posix({}, { [posixBuiltin]: "prefix=/opt/homebrew" }), null);
			assert.equal(posix({}, { [posixBuiltin]: "userconfig=/etc/other-npmrc" }), null, "it moves the user npmrc");
		});

		test("4: other keys in the builtin npmrc don't count", () => {
			assert.equal(posix({}, { [posixBuiltin]: "update-notifier=false\n" }), join(nodeDir, "lib", "node_modules"));
			const appdata = join(tmpdir(), "Roaming");
			assert.equal(
				win({ APPDATA: appdata }, { [winBuiltin]: "update-notifier=false\nprefix=${APPDATA}\\npm" }),
				join(appdata, "npm", "node_modules"),
			);
		});

		test("4 and 5: with no npm beside this Node (Homebrew, Debian), ask npm", () => {
			const noNpm = () => null;
			assert.equal(npmGlobalRoot({ env: {}, platform: "linux", execPath: join(nodeDir, "bin", "node"), home, readText: noNpm }), null);
			assert.equal(npmGlobalRoot({ env: {}, platform: "win32", execPath: join(nodeDir, "node.exe"), home, readText: noNpm }), null);
		});

		test("4: the global npmrc under %APPDATA%\\npm still counts", () => {
			const appdata = join(tmpdir(), "Roaming");
			assert.equal(
				win(
					{ APPDATA: appdata },
					{ [winBuiltin]: "prefix=${APPDATA}\\npm", [join(appdata, "npm", "etc", "npmrc")]: "prefix=D:\\npm" },
				),
				null,
			);
		});

		// A detector, not a law: a worked-out root models the npm beside this
		// Node, and PATH's npm can differ (globalQmdEntry asks npm on a miss
		// for that reason). On a stock install, CI's included, the two agree;
		// a leg where they don't fails here rather than silently.
		test("a root worked out on this machine is the one npm gives", (t) => {
			// Without the npm_config_* that `npm test` exports, or rule 1 only echoes npm back.
			const ours = npmGlobalRoot({ env: withoutNpmConfig() });
			if (ours === null) return t.skip("no worked-out root here; the caller asks npm");
			const answer = npmAnswer();
			if (answer === null) return t.skip("npm is not available here");
			assert.equal(resolve(ours).toLowerCase(), resolve(answer).toLowerCase());
		});
	});
}

for (const [label, globalQmdEntry] of [
	["lib/qmd.ts", globalQmdEntryTs],
	["qmd-mcp.mjs", globalQmdEntryMjs],
] as const) {
	describe(`${label} globalQmdEntry`, () => {
		const withRoot = (run: (root: string) => void): void => {
			const root = mkdtempSync(join(tmpdir(), "npm-root-"));
			try {
				run(root);
			} finally {
				rmTemp(root);
			}
		};

		test("qmd under a worked-out root is found without asking npm", () => {
			withRoot((root) => {
				const entry = join(root, QMD_ENTRY);
				mkdirSync(dirname(entry), { recursive: true });
				writeFileSync(entry, "");
				let asked = false;
				assert.equal(globalQmdEntry(root, () => ((asked = true), null)), entry);
				assert.equal(asked, false, "no npm root -g spawn");
			});
		});

		test("a worked-out root without qmd still asks npm: the npm on PATH can differ", () => {
			withRoot((computed) => {
				withRoot((npms) => {
					const entry = join(npms, QMD_ENTRY);
					mkdirSync(dirname(entry), { recursive: true });
					writeFileSync(entry, "");
					assert.equal(globalQmdEntry(computed, () => npms), entry);
				});
			});
		});

		test("no worked-out root asks npm, and finds qmd under its answer", () => {
			withRoot((root) => {
				const entry = join(root, QMD_ENTRY);
				mkdirSync(dirname(entry), { recursive: true });
				writeFileSync(entry, "");
				assert.equal(globalQmdEntry(null, () => root), entry);
			});
		});
	});
}
