/**
 * Cross-platform QMD invocation helpers.
 *
 * Bare `spawnSync("qmd", ...)` fails on Windows because npm installs qmd as a
 * .cmd/.ps1 shim that Node's spawn can't resolve without routing through the
 * platform shell — and even with `shell: true` the .cmd shim itself depends
 * on /bin/sh via %_prog%, which fails on stock Windows without Git Bash.
 *
 * Rather than scatter platform-conditional `shell: process.platform === "win32"`
 * flags across every qmd call, these helpers resolve @tobilu/qmd's real JS
 * entry and let callers spawn it with the current Node binary. No shell, no
 * shim, same code path on Windows, macOS, and Linux.
 *
 * Shared with `.claude/scripts/qmd-mcp.mjs` by duplicated implementation —
 * that file is .mjs (MCP servers run as their own entry), so it can't import
 * this .ts helper at Node's `--experimental-strip-types` runtime. The two
 * copies are asserted independently: `tests/qmd.test.ts` locks this file's
 * `resolveQmdEntry` + `buildQmdCommand` shape, and `tests/qmd-mcp.test.ts`
 * locks the .mjs wrapper's equivalents; `tests/qmd.test.ts` also runs
 * `pickQmdEntry`, `npmGlobalRoot` and `globalQmdEntry` against both copies. Drift between the
 * two shows up as a test failure on the CI matrix rather than a silent
 * platform bug.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { debug } from "./hook-io.ts";

const require = createRequire(import.meta.url);

/**
 * Locate @tobilu/qmd's real JS entrypoint. Returns an absolute path when
 * resolvable, null when not. A null return signals the caller to fall back
 * to invoking `qmd` directly via the platform shell (last-resort path for
 * non-npm installs). A runnable install is preferred over one that merely
 * exists — see {@link pickQmdEntry}.
 */
export function resolveQmdEntry(): string | null {
	return pickQmdEntry([localQmdEntry, globalQmdEntry], isRunnableQmdEntry);
}

/**
 * Choose among candidate entrypoints, in order. Each source returns a path
 * that EXISTS, or null. A present entry can still be broken — missing
 * dependencies, a half-finished install, a native binding built for another
 * Node ABI — and a broken first candidate must not shadow a working later one.
 *
 * - The first present candidate that passes `runnable` wins.
 * - When every present candidate fails, the FIRST present one is returned, not
 *   null: SessionStart's ABI self-heal needs a broken entry to find the
 *   package it rebuilds.
 * - A candidate with nothing after it to fall back to, and nothing before it,
 *   is returned without a probe: probing could not change the answer. That is
 *   the common single-install case, which therefore costs no extra spawn.
 *
 * Sources are thunks so a runnable early candidate never pays for the later
 * lookups (`npm root -g` is a shell spawn).
 */
export function pickQmdEntry(
	sources: ReadonlyArray<() => string | null>,
	runnable: (entry: string) => boolean,
): string | null {
	let firstPresent: string | null = null;
	for (let i = 0; i < sources.length; i++) {
		const entry = (sources[i] as () => string | null)();
		if (entry === null) continue;
		if (firstPresent === null && i === sources.length - 1) return entry;
		if (runnable(entry)) return entry;
		firstPresent ??= entry;
	}
	return firstPresent;
}

/**
 * Does this entrypoint actually start? `--version` is the cheapest call that
 * loads the CLI. Bounded, so a hung install reads as broken rather than
 * blocking a hook.
 */
export function isRunnableQmdEntry(entry: string): boolean {
	const probe = spawnSync(process.execPath, [entry, "--version"], {
		encoding: "utf8",
		timeout: 10_000,
		windowsHide: true,
	});
	return !probe.error && probe.signal === null && probe.status === 0;
}

function localQmdEntry(): string | null {
	try {
		return require.resolve("@tobilu/qmd/dist/cli/qmd.js");
	} catch {
		return null;
	}
}

/** What `npmGlobalRoot` reads; each defaults to this process, so tests need no real npm install. */
export interface NpmLocation {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly platform?: string;
	readonly execPath?: string;
	readonly home?: string;
	/** The OS home lookup; it throws for a UID with no passwd entry. */
	readonly osHome?: () => string;
	/** A file's text, or null when it can't be read. */
	readonly readText?: (path: string) => string | null;
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Where npm keeps global packages, without spawning it (#349): `npm root -g`
 * is a shell plus a Node start on every resolve (0.1-1 s on CI runners,
 * measured 2026-10-13, #349). Only the
 * cheap exact cases are worked out here; anything else returns null, and the
 * caller asks npm, which gives its exact answer at the old cost.
 *
 * 1. npm_config_prefix in the env (any case): use it if it's an absolute path
 *    with no `${` and no surrounding whitespace, else ask npm.
 * 2. PREFIX, DESTDIR, npm_config_userconfig or npm_config_globalconfig set →
 *    ask npm.
 * 3. ~/.npmrc (HOME before the OS home) or `<node prefix>/etc/npmrc` has a
 *    line setting `prefix` or `globalconfig`, sections included, or a key
 *    npm's ini would rewrite (quoted, which it unquotes, escapes and all;
 *    built from `${…}`; or holding `;` or `#`, which cut it, brackets, a
 *    backslash or whitespace) → ask npm. An npmrc with only auth or
 *    registry lines (or `save-prefix`) doesn't count.
 * 4. The builtin npmrc: on Windows, the installer's exact
 *    `prefix=${APPDATA}\npm` → %APPDATA%\npm. Any other line there setting
 *    `prefix`, `globalconfig` or `userconfig` (which moves the user npmrc),
 *    or a key npm's ini would rewrite → ask npm.
 * 5. Otherwise Node's own prefix.
 *
 * 4 and 5 hold only when npm sits beside this Node; where it doesn't
 * (Homebrew, Debian's packaged npm), ask npm. Env values are read as npm
 * reads them: only "" skipped, nothing trimmed, the last of several winning
 * (@npmcli/config's loadEnv, read in npm 10.9.2 on 2026-10-14). Rule 3 needs a home: when
 * the OS can't name one (a UID with no passwd entry), ask npm.
 *
 * Packages sit in `<prefix>\node_modules` on Windows and
 * `<prefix>/lib/node_modules` elsewhere.
 */
export function npmGlobalRoot(at: NpmLocation = {}): string | null {
	const vars = at.env ?? process.env;
	const win = (at.platform ?? process.platform) === "win32";
	const execPath = at.execPath ?? process.execPath;
	const readText = at.readText ?? readTextOrNull;
	// Rule 1's env reading: the last non-empty value, untrimmed.
	const npmConfig = (key: string): string | undefined => {
		const want = `npm_config_${key}`;
		let found: string | undefined;
		for (const [name, value] of Object.entries(vars)) {
			if (name.toLowerCase() === want && value) found = value;
		}
		return found;
	};
	const lines = (file: string): string[] =>
		(readText(file) ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !/^[;#]/.test(l));
	// Rules 3 and 4: a line setting one of `keys`, or one whose key npm's
	// ini would turn into something this can't read: quoted (unquoted and
	// decoded), built from `${…}`, or holding `;` or `#` (ini cuts the key
	// there), brackets, a backslash or whitespace. Auth keys (`//host/path/:_authToken`, with % ~ +) are
	// plain. Section headers set nothing.
	const settingLines = (file: string, keys: readonly string[] = ["prefix", "globalconfig"]): string[] =>
		lines(file).filter((l) => {
			if (l.startsWith("[")) return false;
			const key = l.split("=", 1)[0]!.trim();
			return keys.includes(key.toLowerCase()) || /^["']|\$\{|[\s[\]\\;#]/.test(key);
		});
	// Absolute in npm's sense: on a Windows host, `\npm` is drive-relative.
	// Padded values ask npm: how its path handling treats them is not read here.
	const exactPath = (value: string): boolean =>
		value === value.trim() &&
		isAbsolute(value) &&
		!value.includes("${") &&
		(process.platform !== "win32" || !/^[\\/](?![\\/])/.test(value));
	const layout = (prefix: string): string => (win ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules"));

	// 1.
	const fromEnv = npmConfig("prefix");
	if (fromEnv !== undefined) return exactPath(fromEnv) ? layout(fromEnv) : null;

	// 2.
	if (vars["PREFIX"] || vars["DESTDIR"] || npmConfig("userconfig") !== undefined || npmConfig("globalconfig") !== undefined) {
		return null;
	}

	// 3.
	let home: string;
	try {
		home = at.home ?? (vars["HOME"] || (at.osHome ?? homedir)());
	} catch {
		return null; // no home to find ~/.npmrc in (a UID with no passwd entry)
	}
	const nodePrefix = win ? dirname(execPath) : dirname(dirname(execPath));
	if (settingLines(join(home, ".npmrc")).length > 0 || settingLines(join(nodePrefix, "etc", "npmrc")).length > 0) {
		return null;
	}

	// 4 and 5 hold only for the npm that sits beside this Node; Homebrew and
	// Debian keep npm (and its builtin npmrc) elsewhere, so ask npm there.
	const npmDir = join(win ? nodePrefix : join(nodePrefix, "lib"), "node_modules", "npm");
	if (readText(join(npmDir, "package.json")) === null) return null;

	// 4.
	const builtin = settingLines(join(npmDir, "npmrc"), ["prefix", "globalconfig", "userconfig"]);
	if (builtin.length === 0) return layout(nodePrefix); // 5.
	const appdata = vars["APPDATA"];
	if (!win || builtin.length !== 1 || builtin[0] !== "prefix=${APPDATA}\\npm" || !appdata || !exactPath(appdata)) {
		return null;
	}
	// npm's global npmrc then lives under that prefix.
	const prefix = join(appdata, "npm");
	return settingLines(join(prefix, "etc", "npmrc")).length > 0 ? null : layout(prefix);
}

/** @tobilu/qmd's entry under a global root, when it is there. */
function qmdEntryUnder(root: string): string | null {
	const entry = join(root, "@tobilu", "qmd", "dist", "cli", "qmd.js");
	return existsSync(entry) ? entry : null;
}

/**
 * qmd's entry under npm's global root: under the root `npmGlobalRoot` works
 * out when qmd is there, else under npm's own answer. A worked-out root
 * models the npm beside this Node, and the npm on PATH can differ (a
 * self-upgraded npm on Windows, mixed installs; inferred), so a miss there
 * still asks npm (#399, 2026-10-14).
 */
export function globalQmdEntry(computed: string | null = npmGlobalRoot(), askNpm: () => string | null = askNpmForRoot): string | null {
	const known = computed === null ? null : qmdEntryUnder(computed);
	if (known !== null) return known;
	const root = askNpm();
	return root === null ? null : qmdEntryUnder(root);
}

function askNpmForRoot(): string | null {
	// Fallback for global npm installs that aren't on this package's resolution
	// path — ask npm directly where global packages live. Bounded timeout so a
	// hung npm process can't block a fire-and-forget hook indefinitely.
	//
	// Single-string command with `shell: true` rather than args+shell so this
	// stays clean on Node 24, which emits DEP0190 when args are passed with
	// shell:true (the args get concatenated into the shell command unescaped,
	// a real injection risk in the general case). Our command is a literal
	// constant — no user input — so the concatenated form is safe.
	// windowsHide: under a detached, windowless parent (the bootstrap that
	// session-start spawns), a shell started without it opens a console window.
	const npmRoot = spawnSync("npm root -g", {
		shell: true,
		encoding: "utf8",
		timeout: 3000,
		windowsHide: true,
	});
	if (npmRoot.error || npmRoot.signal !== null || npmRoot.status !== 0) {
		return null;
	}

	const root = (npmRoot.stdout ?? "").trim();
	return root === "" || !isAbsolute(root) ? null : root;
}

/**
 * Build the (command, args, shell) tuple for a qmd invocation. When an
 * entrypoint resolves, `process.execPath` runs it directly with no shell
 * (identical on every platform). When it doesn't, fall back to `qmd` via
 * the platform shell — best-effort for non-npm installs.
 *
 * The shell-fallback path returns the whole invocation in `cmd` with an
 * empty `args` so callers spawn it as a single shell command, not as
 * `args` concatenated with `shell:true` — which Node 24 deprecates
 * (DEP0190) because args+shell concatenation is an injection risk in
 * the general case. Our subcommand args are typically literal constants,
 * but we route through the safe form everywhere so a future caller can't
 * accidentally introduce a shell-injection vector.
 */
export function buildQmdCommand(
	entry: string | null,
	subcommandArgs: readonly string[],
): {
	readonly cmd: string;
	readonly args: readonly string[];
	readonly shell: boolean;
} {
	return entry !== null
		? {
				cmd: process.execPath,
				args: [entry, ...subcommandArgs],
				shell: false,
			}
		: {
				cmd: ["qmd", ...subcommandArgs].join(" "),
				args: [],
				shell: true,
			};
}

/**
 * The switch that stops detached qmd work: the write-time refresh worker,
 * session-start's update, and the MCP server's embed. Every test process
 * carries it, so a suite leaves no qmd work behind (#337, #347); wiki-mind's
 * vendored copy uses the same name (wiki-mind #93).
 */
export const REFRESH_SWITCH = "VAULT_QMD_REFRESH";

/**
 * Whether detached qmd work is switched off for this process: exactly "off".
 * wiki-mind's copy reads the same variable the same way, and one variable
 * must mean the same to every vault's hooks.
 */
export function refreshDisabled(): boolean {
	return process.env[REFRESH_SWITCH] === "off";
}

/**
 * Spawn `command` detached, unless the switch is off: then log under `label`
 * and spawn nothing. The one place a detached qmd process starts, so no
 * caller can forget the switch. Its stdio is ignored, it gets no console
 * window on Windows, and a spawn error (qmd missing) is logged, never thrown
 * as an unhandled `error` event. Returns whether it spawned.
 */
export function spawnDetachedQmd(
	command: { readonly cmd: string; readonly args: readonly string[]; readonly shell: boolean },
	label: string,
	cwd?: string,
): boolean {
	if (refreshDisabled()) {
		debug(`${label}: qmd refresh off (${REFRESH_SWITCH}=off); nothing spawned`);
		return false;
	}
	const child = spawn(command.cmd, [...command.args], {
		stdio: "ignore",
		shell: command.shell,
		detached: true,
		windowsHide: true,
		...(cwd !== undefined ? { cwd } : {}),
	});
	child.on("error", (err) => debug(`${label}: detached qmd failed to start: ${err.message}`));
	child.unref();
	return true;
}

/**
 * Parse a dotted version into a numeric triple. Accepts the bare "2.5.3"
 * shape and the `qmd --version` output shape ("qmd 2.5.3 (655769712a)") by
 * extracting the first x.y.z run. Returns null when no triple is present.
 */
export function parseVersionTriple(
	raw: string,
): readonly [number, number, number] | null {
	const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True when the installed qmd version (raw `--version` output) satisfies the
 * declared minimum. Fails OPEN on anything unparseable — an unknown version
 * must never brick a bootstrap or nag a session; the declared minimum only
 * acts when both sides are readable.
 */
export function qmdVersionAtLeast(actualRaw: string, minRaw: string): boolean {
	const actual = parseVersionTriple(actualRaw);
	const min = parseVersionTriple(minRaw);
	if (actual === null || min === null) return true;
	for (let i = 0; i < 3; i++) {
		if (actual[i]! !== min[i]!) return actual[i]! > min[i]!;
	}
	return true;
}
