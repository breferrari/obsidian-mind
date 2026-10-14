/**
 * The qmd refresh never holds the vault open (#404). On Windows a process's
 * cwd locks its folder, and the refresh worker plus its qmd steps can last
 * minutes, so a rename or delete of the vault failed with EBUSY. They run
 * from the OS temp folder instead, told the vault-relative paths qmd would
 * have read against the vault. Ported from mindframe#144's `qmd-cwd.ts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { localQmdConfigAt, qmdCwdFor, qmdPathsAgainst } from "../lib/qmd-cwd.ts";
import { sentinelPathFrom, workerSpawnOptions } from "../lib/qmd-refresh.ts";
import { rmTemp } from "./_helpers.ts";

const withRoot = (run: (root: string) => void): void => {
	const root = mkdtempSync(join(tmpdir(), "qmd-cwd-"));
	try {
		run(root);
	} finally {
		rmTemp(root);
	}
};

describe("qmdCwdFor", () => {
	test("with an index name, the temp folder: qmd reads nothing else against its cwd", () => {
		withRoot((root) => {
			const vault = join(root, "vault");
			const temp = join(root, "temp");
			mkdirSync(vault);
			mkdirSync(temp);
			assert.equal(qmdCwdFor(vault, "my-vault", temp), temp);
		});
	});

	test("a temp folder that doesn't exist keeps the vault", () => {
		withRoot((root) => {
			assert.equal(qmdCwdFor(root, "my-vault", join(root, "missing")), root);
		});
	});

	test("without an index, the vault whenever the temp folder would find a different local config", () => {
		withRoot((root) => {
			const vault = join(root, "vault");
			const temp = join(root, "temp");
			mkdirSync(join(vault, ".qmd"), { recursive: true });
			mkdirSync(temp);
			writeFileSync(join(vault, ".qmd", "index.yml"), "");
			assert.equal(qmdCwdFor(vault, null, temp), vault, "the vault's own config");
		});
	});

	test("without an index, the temp folder when both find the same config, or none", () => {
		withRoot((root) => {
			const vault = join(root, "vault");
			const temp = join(root, "temp");
			mkdirSync(vault);
			mkdirSync(temp);
			// A config above both, or none at all: the same either way.
			assert.equal(qmdCwdFor(vault, null, temp), temp);
		});
	});
});

describe("localQmdConfigAt", () => {
	test("walks up for .qmd/index.yaml, then .qmd/index.yml", () => {
		withRoot((root) => {
			const deep = join(root, "a", "b");
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

describe("the refresh worker spawn (#404)", () => {
	test("runs from the temp folder, not the hook's cwd", () => {
		withRoot((temp) => {
			assert.equal(workerSpawnOptions(temp).cwd, temp);
			assert.equal(workerSpawnOptions(temp).windowsHide, true);
		});
	});

	test("a missing temp folder falls back to the hook's cwd", () => {
		assert.equal(workerSpawnOptions(join(tmpdir(), "no-such-temp-404")).cwd, process.cwd());
	});

	test("a relative QMD_REFRESH_SENTINEL is made absolute: the worker gets it from another cwd", () => {
		const got = sentinelPathFrom({ QMD_REFRESH_SENTINEL: "rel/sentinel" }, tmpdir());
		assert.ok(isAbsolute(got));
		assert.equal(got, resolve("rel/sentinel"));
	});
});
