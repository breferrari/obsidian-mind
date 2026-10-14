/**
 * Where a qmd call about the vault runs, and what it is told, so the refresh
 * can run from the OS temp folder without holding the vault open (#404). On
 * Windows a process's cwd locks its folder, and a refresh lasts minutes, so a
 * rename or delete of the vault failed with EBUSY.
 *
 * Each rule follows what @tobilu/qmd reads against its cwd, as read in its
 * 2.5.3 dist by mindframe (cli/qmd.js's index selection, collections.js's
 * findLocalConfigPath and getConfigDir, store.js's getDefaultDbPath) and not
 * yet re-read here (TBC). Ported from mindframe#144's `qmd-cwd.ts`.
 */

import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The project-local qmd config at or above `dir`, as qmd looks for it when no
 * `--index` is given (`findLocalConfigPath`, from its cwd): `.qmd/index.yaml`,
 * then `.qmd/index.yml`, walking up. Null when none.
 */
export function localQmdConfigAt(dir: string): string | null {
	for (let at = resolve(dir); ; at = dirname(at)) {
		for (const name of ["index.yaml", "index.yml"]) {
			const file = join(at, ".qmd", name);
			if (existsSync(file)) return file;
		}
		if (dirname(at) === at) return null;
	}
}

/**
 * The cwd for a qmd call about `vault`: the OS temp folder. With an index
 * name, qmd reads nothing against its cwd but the variables `qmdPathsAgainst`
 * pins. Without one, it uses the first project-local config above its cwd,
 * which no flag can pass, so the vault stays the cwd whenever the temp folder
 * would find a different one (the vault's own, or one in the user profile the
 * temp folder sits in on Windows). Both are walked as qmd walks its
 * `process.cwd()`: by the real path on POSIX, where the cwd is always
 * resolved, and as given on Windows, where it keeps a junction or `subst`
 * drive. A temp folder that doesn't exist keeps the vault.
 */
export function qmdCwdFor(vault: string, qmdIndex: string | null, temp: string = tmpdir(), platform: NodeJS.Platform = process.platform): string {
	if (!existsSync(temp)) return vault;
	if (qmdIndex !== null) return temp;
	const asCwd = (dir: string): string => (platform === "win32" ? dir : realOr(dir));
	return localQmdConfigAt(asCwd(temp)) === localQmdConfigAt(asCwd(vault)) ? temp : vault;
}

const realOr = (dir: string): string => {
	try {
		return realpathSync.native(dir);
	} catch {
		return dir;
	}
};

/**
 * `env` with the path variables qmd reads against its cwd resolved against
 * the vault: INDEX_PATH, QMD_CONFIG_DIR, XDG_CONFIG_HOME and XDG_CACHE_HOME
 * (`getDefaultDbPath` and `getConfigDir` use them as given). A qmd call from
 * outside the vault then reads them as the vault would have; an absolute one
 * is kept, and a Windows root-relative one (`\idx`) takes the vault's drive.
 * Empty ones are qmd's unset and stay so.
 */
export function qmdPathsAgainst(vault: string, env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
	const pinned: Record<string, string | undefined> = { ...env };
	for (const key of ["INDEX_PATH", "QMD_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
		const value = env[key];
		if (value) pinned[key] = resolve(vault, value);
	}
	return pinned;
}
