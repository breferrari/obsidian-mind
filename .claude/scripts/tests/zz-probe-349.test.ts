/**
 * THROWAWAY probe for #349: where a session-start spawn's time goes on each
 * runner. Reports only, never fails. Not for merge.
 */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "session-start.ts");
const PRELOAD = pathToFileURL(join(HERE, "_probe-spawnlog.mjs")).href;

const time = (args: string[], input?: string, env?: NodeJS.ProcessEnv) => {
	const s = performance.now();
	const r = spawnSync(process.execPath, args, { input, env, encoding: "utf8" });
	return { ms: performance.now() - s, stderr: r.stderr ?? "" };
};

test("probe #349: session-start spawn breakdown", (t) => {
	t.diagnostic(`platform ${process.platform} node ${process.version}`);
	const empty = join(mkdtempSync(join(tmpdir(), "probe-")), "empty.ts");
	writeFileSync(empty, "export {};\n");
	for (let i = 0; i < 2; i++) t.diagnostic(`node -e 0: ${time(["-e", "0"]).ms.toFixed(0)}ms`);
	for (let i = 0; i < 2; i++) t.diagnostic(`node strip-types empty.ts: ${time(["--experimental-strip-types", empty]).ms.toFixed(0)}ms`);
	const npm = spawnSync("npm root -g", { shell: true, encoding: "utf8" });
	t.diagnostic(`npm root -g -> ${(npm.stdout ?? "").trim()}`);
	for (let i = 0; i < 3; i++) {
		const vault = mkdtempSync(join(tmpdir(), "probe-vault-"));
		mkdirSync(join(vault, "brain"));
		writeFileSync(join(vault, "AGENTS.md"), "# Vault\n");
		writeFileSync(join(vault, "brain", "North Star.md"), "---\ndate: 2026-10-13\n---\n# North Star\n");
		const r = time(
			["--import", PRELOAD, "--experimental-strip-types", SCRIPT],
			JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
			{ ...process.env, CLAUDE_PROJECT_DIR: vault },
		);
		t.diagnostic(`run ${i + 1}: whole spawn ${r.ms.toFixed(0)}ms`);
		for (const line of r.stderr.split("\n").filter((l) => l.startsWith("[spawn]") || l.startsWith("[total]"))) t.diagnostic(`  ${line}`);
		rmSync(vault, { recursive: true, force: true });
	}
});

test("probe #349: qmd directly, with no timeout cutting it", (t) => {
	const root = (spawnSync("npm root -g", { shell: true, encoding: "utf8" }).stdout ?? "").trim();
	const entry = join(root, "@tobilu", "qmd", "dist", "cli", "qmd.js");
	const run = (label: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
		const s = performance.now();
		const r = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 60_000, env });
		t.diagnostic(`${label}: ${(performance.now() - s).toFixed(0)}ms status=${r.status} signal=${r.signal} error=${r.error?.message ?? "-"}`);
		const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-6);
		for (const l of tail) t.diagnostic(`    | ${l.slice(0, 160)}`);
	};
	run("qmd --version", ["--version"]);
	run("qmd --index probe-direct status", ["--index", "probe-direct", "status"]);
	run("qmd --index probe-direct status (again)", ["--index", "probe-direct", "status"]);
	run("qmd status with QMD_FORCE_CPU=1", ["--index", "probe-cpu", "status"], { ...process.env, QMD_FORCE_CPU: "1" });
	t.diagnostic(`env XDG_CACHE_HOME=${process.env["XDG_CACHE_HOME"] ?? "-"} QMD_CONFIG_DIR=${process.env["QMD_CONFIG_DIR"] ?? "-"}`);
});
