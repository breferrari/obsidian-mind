/**
 * obsidian-mind post-install hook.
 *
 * Runs once after `shardmind install` writes the vault and its state. Non-fatal:
 * throwing surfaces as a warning in the install summary, never rolls back the
 * install. See ShardMind docs/ARCHITECTURE.md §9.3.
 *
 * Responsibilities (all idempotent, all skippable):
 *   1. Initialize a git repo at the vault root if one doesn't already exist.
 *      Creates an *unmanaged* `.git/` directory — Invariant 2 doesn't apply
 *      (only managed-file edits are gated on `valuesAreDefaults`).
 *   2. Personalize the managed `brain/North Star.md` with the user's name —
 *      gated on `!ctx.valuesAreDefaults` per Invariant 2 (with all values at
 *      defaults, the install must remain byte-equivalent to `git clone`).
 *      The engine re-hashes managed files after the hook exits, so state.json
 *      reflects the post-edit content (#75).
 *   3. Bootstrap the QMD semantic index when `qmd_enabled === true`. Creates
 *      `.qmd/` (unmanaged), so this branch ignores `valuesAreDefaults` and
 *      runs unconditionally inside the `qmd_enabled` gate. Skips silently if
 *      the `qmd` binary isn't on PATH — the user gets a note in stdout
 *      telling them how to install it later. We never hard-fail on optional
 *      tooling.
 *
 * `personalizeNorthStar` and `ensureGitRepo` are exported by name so the
 * test suite can drive them with synthetic vault layouts.
 */

import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Vault-relative path to the QMD bootstrap script. Centralized so a future
// rename is a one-line change. Lives at vault root under `scripts/`, not
// `.claude/scripts/` — the README's QMD setup section invokes the same path
// (`node --experimental-strip-types scripts/qmd-bootstrap.ts`), and changing
// it would silently desync the manual setup path from the hook's automated
// one.
const QMD_BOOTSTRAP_RELATIVE = 'scripts/qmd-bootstrap.ts';

// Local mirror of ShardMind's HookContext shape. Inlined (rather than imported
// from `shardmind/runtime`) so obsidian-mind has no shardmind dependency —
// the engine's hook runner spawns this file via tsx and the types are erased
// at runtime. Kept in sync with `source/runtime/types.ts::HookContext` in
// the shardmind repo. See ShardMind docs/SHARD-LAYOUT.md §Hooks, state, and
// re-hash semantics.
interface HookCtx {
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
  previousVersion?: string;
  valuesAreDefaults: boolean;
  newFiles: string[];
  removedFiles: string[];
}

export default async function postInstall(ctx: HookCtx): Promise<void> {
  await ensureGitRepo(ctx.vaultRoot);

  // Invariant 2: managed-file edits are gated on `!valuesAreDefaults`. With
  // every value at its schema default, the install MUST stay byte-equivalent
  // to `git clone` — so we leave North Star alone. When the user supplied a
  // non-default name (or any other value), personalize the heading.
  if (!ctx.valuesAreDefaults) {
    const userName = typeof ctx.values['user_name'] === 'string' ? ctx.values['user_name'] : '';
    if (userName.trim().length > 0) {
      await personalizeNorthStar(ctx.vaultRoot, userName);
    }
  }

  if (ctx.values['qmd_enabled'] === true) {
    await bootstrapQmd(ctx.vaultRoot);
  }
}

export async function ensureGitRepo(vaultRoot: string): Promise<void> {
  try {
    await access(join(vaultRoot, '.git'));
    console.log('git: repository already present — skipping git init');
    return;
  } catch (err) {
    // ENOENT — the expected case — falls through to `git init`. Any
    // other code (EACCES on a permission-restricted .git/, EBUSY, …)
    // means a `.git/` exists but we can't see it; running `git init`
    // would either silently re-init an existing repo or fail with a
    // less obvious follow-on error. Surface the original errno so the
    // user knows why init didn't run.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      console.error(`git: cannot inspect ${join(vaultRoot, '.git')} (${code}) — skipping git init. Run \`git init\` manually if needed.`);
      return;
    }
  }

  const ok = await run('git', ['init', '--quiet'], vaultRoot);
  if (ok) {
    console.log('git: initialized repository at vault root');
  } else {
    console.error('git: init failed — install succeeded but the vault is not version-controlled. Run `git init` manually.');
  }
}

/**
 * Replace `# North Star` with `# North Star — <userName>` once. Idempotent:
 * a heading already personalized (with this name or any other) is left
 * alone — the regex anchors to the literal verbatim form. ENOENT-tolerant:
 * if `brain/` was deselected (the `brain` module is `removable: false`,
 * so this shouldn't happen in practice, but the guard costs nothing) or
 * the file moved upstream, the hook exits cleanly.
 */
export async function personalizeNorthStar(vaultRoot: string, userName: string): Promise<void> {
  const target = join(vaultRoot, 'brain', 'North Star.md');
  let original: string;
  try {
    original = await readFile(target, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`obsidian-mind: ${target} not present — skipping North Star personalization.`);
      return;
    }
    throw err;
  }

  // Anchor to the verbatim heading. If the file has already been personalized
  // (heading reads `# North Star — <something>`), `^# North Star$/m` won't
  // match and the file is left untouched — making the hook idempotent.
  if (!/^# North Star$/m.test(original)) {
    return;
  }

  const personalized = original.replace(/^# North Star$/m, `# North Star — ${userName}`);
  await writeFile(target, personalized, 'utf-8');
  console.log(`obsidian-mind: personalized brain/North Star.md for ${userName}`);
}

async function bootstrapQmd(vaultRoot: string): Promise<void> {
  const bootstrap = join(vaultRoot, QMD_BOOTSTRAP_RELATIVE);
  try {
    await access(bootstrap);
  } catch {
    console.error(`qmd: bootstrap script not found at ${bootstrap} — skipping`);
    return;
  }

  const qmdAvailable = await which('qmd');
  if (!qmdAvailable) {
    console.log('qmd: `qmd` binary not found on PATH — skipping bootstrap.');
    console.log(`qmd: install with \`npm install -g @tobilu/qmd\`, then run \`node --experimental-strip-types ${QMD_BOOTSTRAP_RELATIVE}\` from the vault root.`);
    return;
  }

  console.log('qmd: bootstrapping semantic index (this may take a moment on first run)…');
  const ok = await run('node', ['--experimental-strip-types', bootstrap], vaultRoot);
  if (ok) {
    console.log('qmd: index bootstrap complete.');
  } else {
    console.error(`qmd: bootstrap exited non-zero. The vault is installed; re-run manually with \`node --experimental-strip-types ${QMD_BOOTSTRAP_RELATIVE}\`.`);
  }
}

function run(command: string, args: string[], cwd: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
  // `quiet` discards stdout + stderr — used by `which()` so a successful
  // tool-availability probe doesn't print the resolved path into the hook
  // log alongside the prefixed `qmd:` / `git:` messages. The user-visible
  // subprocess paths (`git init`, `node qmd-bootstrap.ts`) keep `inherit`
  // so their progress streams through to the install summary.
  const out: 'ignore' | 'inherit' = opts.quiet ? 'ignore' : 'inherit';
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', out, out], shell: false });
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
  });
}

async function which(binary: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return run(cmd, [binary], process.cwd(), { quiet: true });
}
