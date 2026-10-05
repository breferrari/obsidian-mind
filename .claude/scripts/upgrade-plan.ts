#!/usr/bin/env node
/**
 * upgrade-plan — the ShardMind-aware preflight for `/om-vault-upgrade` (#101).
 *
 *   node --experimental-strip-types .claude/scripts/upgrade-plan.ts [--json] [--apply-behind] [--source <ref>]
 *
 * Reads the vault, never changes it (except with --apply-behind, below):
 * - managed (`.shardmind/state.json`): `shardmind --json` and
 *   `shardmind update --dry-run --json`, classified by `classifyUpdate`;
 * - cloned without ShardMind (a `vault-manifest.json`, no state): the
 *   release it was cloned from is the manifest's `version`; runs
 *   `shardmind adopt <source> --from-version <v> --dry-run --yes --json`,
 *   fetches that release to hash each file's base, and classifies with
 *   `classifyAdopt`.
 * Prints the report (or, with --json, `{ mode, from, to, report }`).
 *
 * --apply-behind (unmanaged clone only): writes the latest release's bytes
 * for every BEHIND file — one the user never changed — after checking each
 * against adopt's `shardHash`, so a following
 * `shardmind adopt … --mode keep-all-mine` keeps exactly the files that are
 * really the user's. Without it, keep-all-mine would record the stale files
 * as user-modified, and no later update would ever touch them.
 *
 * Requires ShardMind 0.2.0 or later (`--json`).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "./lib/main-guard.ts";
import { resolveProjectDir } from "./lib/project-dir.ts";
import {
	classifyAdopt,
	classifyUpdate,
	formatUpgradeReport,
	type AdoptPlan,
	type ShardmindEnvelope,
	type StatusResult,
	type UpdatePlan,
	type UpgradeReport,
} from "./lib/upgrade-plan.ts";

const DEFAULT_SOURCE = "github:breferrari/obsidian-mind";

function fail(message: string): never {
	process.stderr.write(`upgrade-plan: ${message}\n`);
	process.exit(1);
}

/**
 * ShardMind's real entry point, run with this Node, so no shell or `.cmd`
 * shim is involved (the same reason qmd is launched this way, #54). Falls
 * back to `shardmind` on PATH through the shell.
 */
function shardmindCommand(args: readonly string[]): { cmd: string; args: string[]; shell: boolean } {
	const root = spawnSync("npm root -g", { shell: true, encoding: "utf8", timeout: 10_000 }).stdout?.trim() ?? "";
	const entry = root ? join(root, "shardmind", "dist", "cli.js") : "";
	if (entry && existsSync(entry)) return { cmd: process.execPath, args: [entry, ...args], shell: false };
	// No argument here comes from outside this script except the source ref,
	// which main() checks against a strict pattern.
	return { cmd: ["shardmind", ...args].join(" "), args: [], shell: true };
}

/** Run ShardMind and parse its `--json` envelope. */
function shardmind<T>(vault: string, args: readonly string[]): ShardmindEnvelope<T> {
	const c = shardmindCommand([...args, "--no-update-check"]);
	const r = spawnSync(c.cmd, c.args, {
		cwd: vault,
		shell: c.shell,
		encoding: "utf8",
		timeout: 300_000,
		input: "",
		env: { ...process.env, CI: "true" },
	});
	try {
		return JSON.parse(r.stdout) as ShardmindEnvelope<T>;
	} catch {
		fail(`shardmind ${args[0] ?? ""} gave no JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
	}
}

function versionAtLeast(v: string, min: readonly number[]): boolean {
	const parts = v.trim().replace(/^v/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10));
	for (let i = 0; i < min.length; i++) {
		const a = parts[i] ?? 0;
		if (a !== min[i]) return a > (min[i] as number);
	}
	return true;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** A shallow clone of `source` at tag `v<version>`, in a temp folder. */
function cloneRelease(source: string, version: string): string {
	const repo = source.replace(/^github:/, "").replace(/[#@].*$/, "");
	const dir = mkdtempSync(join(tmpdir(), "om-upgrade-base-"));
	const r = spawnSync("git", ["clone", "-q", "--depth", "1", "--branch", `v${version}`, `https://github.com/${repo}`, dir], {
		encoding: "utf8",
		timeout: 120_000,
	});
	if (r.status !== 0) fail(`could not fetch ${repo} v${version}: ${r.stderr.slice(0, 300)}`);
	return dir;
}

/** The newest stable `vX.Y.Z` tag of `source`. */
function latestRelease(source: string): string {
	const repo = source.replace(/^github:/, "").replace(/[#@].*$/, "");
	const r = spawnSync("git", ["ls-remote", "--tags", `https://github.com/${repo}`], { encoding: "utf8", timeout: 60_000 });
	const tags = [...r.stdout.matchAll(/refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/gm)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
	if (tags.length === 0) fail(`no release tags found for ${repo}`);
	tags.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
	return (tags[0] as readonly number[]).join(".");
}

function main(): void {
	const args = process.argv.slice(2);
	const asJson = args.includes("--json");
	const applyBehind = args.includes("--apply-behind");
	const sourceIdx = args.indexOf("--source");
	const source = sourceIdx >= 0 ? (args[sourceIdx + 1] ?? "") : DEFAULT_SOURCE;
	if (!/^(github:)?[\w.-]+\/[\w.-]+$/.test(source)) fail(`not a shard reference: ${source}`);

	const vault = resolveProjectDir(process.cwd());
	const v = shardmindCommand(["--version"]);
	const ver = spawnSync(v.cmd, v.args, { shell: v.shell, encoding: "utf8", timeout: 60_000 });
	if (ver.status !== 0) fail("ShardMind is not installed. Install it (npm i -g shardmind) or use the manual migration in /om-vault-upgrade.");
	if (!versionAtLeast(ver.stdout, [0, 2, 0])) fail(`ShardMind ${ver.stdout.trim()} is too old; 0.2.0 or later is needed for --json. Run: npm i -g shardmind@latest`);

	let mode: "managed" | "unmanaged";
	let from = "?";
	let to = "?";
	let report: UpgradeReport;

	if (existsSync(join(vault, ".shardmind", "state.json"))) {
		mode = "managed";
		const status = shardmind<StatusResult>(vault, ["--json"]);
		if (!status.ok) fail(`status: ${status.error.message}${status.error.hint ? ` — ${status.error.hint}` : ""}`);
		from = status.result.version ?? "?";
		to = status.result.update?.latest ?? from;
		const plan = shardmind<UpdatePlan>(vault, ["update", "--dry-run", "--json"]);
		if (!plan.ok) fail(`update plan: ${plan.error.message}${plan.error.hint ? ` — ${plan.error.hint}` : ""}`);
		report = classifyUpdate(plan.result, status.result);
	} else {
		mode = "unmanaged";
		let manifest: { version?: unknown } = {};
		try {
			manifest = JSON.parse(readFileSync(join(vault, "vault-manifest.json"), "utf8")) as { version?: unknown };
		} catch {
			fail("no .shardmind/state.json and no vault-manifest.json: not an obsidian-mind vault. Use the manual migration in /om-vault-upgrade.");
		}
		if (typeof manifest.version !== "string") fail("vault-manifest.json has no version, so the release this vault came from is unknown.");
		from = manifest.version;
		to = latestRelease(source);
		const plan = shardmind<AdoptPlan>(vault, ["adopt", source, "--from-version", from, "--dry-run", "--yes", "--json"]);
		if (!plan.ok) fail(`adopt plan: ${plan.error.message}${plan.error.hint ? ` — ${plan.error.hint}` : ""}`);
		const base = cloneRelease(source, from);
		try {
			report = classifyAdopt(plan.result, (p) => {
				const f = join(base, p);
				return existsSync(f) ? sha256(readFileSync(f)) : null;
			});
		} finally {
			rmSync(base, { recursive: true, force: true });
		}

		if (applyBehind && report.behind.length > 0) {
			const latest = cloneRelease(source, to);
			try {
				const want = new Map(plan.result.files.map((f) => [f.path, f.shardHash]));
				for (const p of report.behind) {
					const bytes = readFileSync(join(latest, p));
					if (sha256(bytes) !== want.get(p)) fail(`${p} at v${to} does not match adopt's plan; nothing more was written`);
					writeFileSync(join(vault, p), bytes);
				}
			} finally {
				rmSync(latest, { recursive: true, force: true });
			}
			process.stderr.write(`upgrade-plan: wrote v${to} of ${report.behind.length} behind file(s)\n`);
		}
	}

	process.stdout.write(
		asJson ? `${JSON.stringify({ mode, from, to, report }, null, 2)}\n` : `${formatUpgradeReport(report, `v${from}`, `v${to}`)}\n`,
	);
}

if (isMainModule(import.meta.url)) main();
