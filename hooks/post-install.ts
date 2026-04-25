/**
 * obsidian-mind post-install hook.
 *
 * Runs once after `shardmind install` writes the vault and its state. Non-fatal:
 * throwing surfaces as a warning in the install summary, never rolls back the
 * install. See ShardMind docs/ARCHITECTURE.md §9.3.
 *
 * Responsibilities (all idempotent, all skippable):
 *   1. Initialize a git repo at the vault root if one doesn't already exist.
 *      The vault is meant to be git-tracked; doing this here saves every user
 *      from `cd <vault> && git init` as a first step.
 *   2. Bootstrap the QMD semantic index when the user answered `qmd_enabled: true`.
 *      Skips silently if the `qmd` binary isn't on PATH — the user gets a note
 *      in stdout telling them how to install it later. We never hard-fail on
 *      optional tooling.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookContext } from 'shardmind/runtime';

export default async function postInstall(ctx: HookContext): Promise<void> {
  await ensureGitRepo(ctx.vaultRoot);
  if (ctx.values['qmd_enabled'] === true) {
    await bootstrapQmd(ctx.vaultRoot);
  }
}

async function ensureGitRepo(vaultRoot: string): Promise<void> {
  try {
    await access(join(vaultRoot, '.git'));
    console.log('git: repository already present — skipping git init');
    return;
  } catch {
    // fall through to init
  }

  const ok = await run('git', ['init', '--quiet'], vaultRoot);
  if (ok) {
    console.log('git: initialized repository at vault root');
  } else {
    console.error('git: init failed — install succeeded but the vault is not version-controlled. Run `git init` manually.');
  }
}

async function bootstrapQmd(vaultRoot: string): Promise<void> {
  const bootstrap = join(vaultRoot, '.claude', 'scripts', 'qmd-bootstrap.ts');
  try {
    await access(bootstrap);
  } catch {
    console.error(`qmd: bootstrap script not found at ${bootstrap} — skipping`);
    return;
  }

  const qmdAvailable = await which('qmd');
  if (!qmdAvailable) {
    console.log('qmd: `qmd` binary not found on PATH — skipping bootstrap.');
    console.log('qmd: install with `npm install -g @tobilu/qmd`, then run `node --experimental-strip-types .claude/scripts/qmd-bootstrap.ts` from the vault root.');
    return;
  }

  console.log('qmd: bootstrapping semantic index (this may take a moment on first run)…');
  const ok = await run('node', ['--experimental-strip-types', bootstrap], vaultRoot);
  if (ok) {
    console.log('qmd: index bootstrap complete.');
  } else {
    console.error('qmd: bootstrap exited non-zero. The vault is installed; re-run manually with `node --experimental-strip-types .claude/scripts/qmd-bootstrap.ts`.');
  }
}

function run(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: false });
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
  });
}

async function which(binary: string): Promise<boolean> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return run(cmd, [binary], process.cwd());
}
