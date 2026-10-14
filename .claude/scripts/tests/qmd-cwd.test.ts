/**
 * The qmd refresh never holds the vault open (lib/qmd-cwd.ts, #404).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { localQmdConfigAt, qmdCwdFor, qmdPathsAgainst } from "../lib/qmd-cwd.ts";
import { workerCwd } from "../lib/qmd-refresh.ts";
import { rmTemp } from "./_helpers.ts";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A temp root holding an empty `vault` and `temp` folder. */
const withVaultAndTemp = (run: (vault: string, temp: string, root: string) => void): void => {
	const root = mkdtempSync(join(tmpdir(), "qmd-cwd-"));
	try {
		mkdirSync(join(root, "vault"));
		mkdirSync(join(root, "temp"));
		run(join(root, "vault"), join(root, "temp"), root);
	} finally {
		rmTemp(root);
	}
};

describe("qmdCwdFor", () => {
	test("with an index name, the temp folder: qmd reads nothing else against its cwd", () => {
		withVaultAndTemp((vault, temp) => assert.equal(qmdCwdFor(vault, "my-vault", temp), temp));
	});

	test("a temp folder that doesn't exist keeps the vault", () => {
		withVaultAndTemp((vault, _temp, root) => assert.equal(qmdCwdFor(vault, "my-vault", join(root, "missing")), vault));
	});

	test("without an index, the vault whenever the temp folder would find a different local config", () => {
		withVaultAndTemp((vault, temp) => {
			mkdirSync(join(vault, ".qmd"));
			writeFileSync(join(vault, ".qmd", "index.yml"), "");
			assert.equal(qmdCwdFor(vault, null, temp), vault, "the vault's own config");
			assert.equal(qmdCwdFor(vault, null, temp, "win32"), vault, "walked as given on Windows too");
		});
	});

	test("without an index, the temp folder when both find the same config, or none", () => {
		withVaultAndTemp((vault, temp) => {
			assert.equal(qmdCwdFor(vault, null, temp), temp);
			assert.equal(qmdCwdFor(vault, null, temp, "win32"), temp);
		});
	});
});

describe("localQmdConfigAt", () => {
	test("walks up for .qmd/index.yaml, then .qmd/index.yml", () => {
		withVaultAndTemp((vault, _temp, root) => {
			const deep = join(vault, "a", "b");
			mkdirSync(deep, { recursive: true });
			mkdirSync(join(root, ".qmd"));
			writeFileSync(join(root, ".qmd", "index.yml"), "");
			assert.equal(localQmdConfigAt(deep), join(root, ".qmd", "index.yml"));
			writeFileSync(join(root, ".qmd", "index.yaml"), "");
			assert.equal(localQmdConfigAt(deep), join(root, ".qmd", "index.yaml"));
		});
	});
});

describe("qmdPathsAgainst", () => {
	test("the paths qmd reads against its cwd are resolved against the vault; absolute and empty ones are kept", () => {
		const vault = resolve(tmpdir(), "vault");
		const absolute = resolve(tmpdir(), "abs-index.sqlite");
		const env = qmdPathsAgainst(vault, {
			INDEX_PATH: "data/index.sqlite",
			QMD_CONFIG_DIR: "cfg",
			XDG_CONFIG_HOME: absolute,
			XDG_CACHE_HOME: "",
			OTHER: "rel/path",
		});
		assert.equal(env["INDEX_PATH"], join(vault, "data", "index.sqlite"));
		assert.equal(env["QMD_CONFIG_DIR"], join(vault, "cfg"));
		assert.equal(env["XDG_CONFIG_HOME"], absolute);
		assert.equal(env["XDG_CACHE_HOME"], "", "empty is qmd's unset");
		assert.equal(env["OTHER"], "rel/path", "only qmd's path variables");
	});
});

describe("workerCwd", () => {
	test("the temp folder, or the hook's cwd when there is none", () => {
		withVaultAndTemp((_vault, temp, root) => {
			assert.equal(workerCwd(temp), temp);
			assert.equal(workerCwd(join(root, "missing")), process.cwd());
		});
	});
});

/**
 * The wiring, which the pure tests above can't reach: the worker's qmd steps
 * and session start's detached update take their cwd and env from these
 * helpers (a top-level script and a hook, so read as source).
 */
describe("each long qmd spawn takes its cwd and env from lib/qmd-cwd.ts", () => {
	const source = (file: string) => readFileSync(join(SCRIPTS, file), "utf8");

	test("the refresh worker's steps", () => {
		const worker = source("qmd-refresh-run.ts");
		assert.match(worker, /const cwd = qmdCwdFor\(VAULT_ROOT, qmdIndex\);/);
		assert.match(worker, /const env = qmdPathsAgainst\(VAULT_ROOT, process\.env\);/);
		assert.match(worker, /spawnSync\(inv\.cmd[\s\S]*?\bcwd,\s*env,\s*\}\);/);
	});

	test("the refresh worker itself", () => {
		assert.match(source("lib/qmd-refresh.ts"), /spawnDetachedQmd\(\{ cmd: process\.execPath, args, shell: false \}, logPrefix, workerCwd\(\)\);/);
	});

	test("session start's detached update", () => {
		const start = source("session-start.ts");
		assert.match(start, /: qmdCwdFor\(cwd, qmdIndex\);/);
		assert.match(start, /: qmdPathsAgainst\(cwd, process\.env\);/);
		assert.match(start, /spawnDetachedQmd\(qmdUpdate, "session-start", qmdCwd, qmdEnv\)/);
	});
});
