/**
 * obsidian-mind bootstrap hook.
 *
 * Runs on first install + adopt, and on update whenever `hooks.bootstrap.fingerprint`
 * in shard.yaml changes (see ShardMind docs/AUTHORING.md §Hook lifecycle). Writes
 * *unmanaged* paths only (`.git/`, `.qmd/`) — the engine warns
 * (`HOOK_BOOTSTRAP_MANAGED_WRITE`) if a bootstrap hook touches a managed file, so
 * this hook never edits vault content. Non-fatal: throwing surfaces as a warning in
 * the install summary, never rolls back the install.
 *
 * Responsibilities (all idempotent, all skippable):
 *   1. Initialize a git repo at the vault root if one doesn't already exist.
 *      Creates an *unmanaged* `.git/` directory.
 *   2. Bootstrap the QMD semantic index when `qmd_enabled === true`. Creates
 *      `.qmd/` (unmanaged). Skips silently if the `qmd` binary isn't on PATH —
 *      the user gets a note in stdout telling them how to install it later. We
 *      never hard-fail on optional tooling.
 *
 * Unlike the legacy `post-install` hook, bootstrap carries no North Star
 * personalization — that moved to `personalize.ts`, which the engine gates on
 * non-default values (Invariant 2 is now engine-enforced, not hook-checked).
 *
 * `ensureGitRepo` is exported by name so the test suite can drive it with
 * synthetic vault layouts.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

// Vault-relative path to the QMD bootstrap script. Centralized so a future
// rename is a one-line change. Lives at vault root under `scripts/`, not
// `.claude/scripts/` — the README's QMD setup section invokes the same path
// (`node --experimental-strip-types scripts/qmd-bootstrap.ts`), and changing
// it would silently desync the manual setup path from the hook's automated
// one.
const QMD_BOOTSTRAP_RELATIVE = 'scripts/qmd-bootstrap.ts';

// Local mirror of ShardMind's BootstrapContext shape. Inlined (rather than
// imported from `shardmind/runtime`) so obsidian-mind has no shardmind
// dependency — the engine's hook runner spawns this file via tsx and the types
// are erased at runtime. Kept in sync with `source/runtime/types.ts::BootstrapContext`
// in the shardmind repo. Bootstrap always runs, so it receives no
// `valuesAreDefaults` flag and no `newFiles`/`removedFiles` (those are
// update-only). See ShardMind docs/AUTHORING.md §Per-slot context shapes.
interface BootstrapContext {
  slot: 'bootstrap';
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
  previousVersion?: string;
}

export default async function bootstrap(ctx: BootstrapContext): Promise<void> {
  await ensureGitRepo(ctx.vaultRoot);

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
