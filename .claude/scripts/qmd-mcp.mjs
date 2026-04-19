#!/usr/bin/env node
/**
 * qmd-mcp.mjs — cross-platform MCP launcher for QMD.
 *
 * Claude Code spawns MCP servers without a shell, so on Windows the npm-installed
 * `qmd` shim (a .cmd/.ps1 file) can't be located from `child_process.spawn`. Even
 * with shell: true, the shim itself delegates to /bin/sh via %_prog%, which fails
 * on stock Windows without Git Bash's sh.exe on PATH.
 *
 * This wrapper bypasses the shim by resolving @tobilu/qmd's real JS entrypoint
 * and spawning it with the current Node binary. Works identically on Windows,
 * macOS, and Linux — no shell, no /bin/sh dependency.
 *
 * Fallback: if @tobilu/qmd isn't resolvable from this location (e.g., the user
 * has qmd installed via a non-npm channel), fall through to the `qmd` command
 * with shell: true so the global shim is still attempted.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveQmdEntry() {
  try {
    return require.resolve('@tobilu/qmd/dist/cli/qmd.js');
  } catch {}

  // Fallback for global npm installs that aren't on this package's resolution
  // path — ask npm directly where global packages live.
  const npmRoot = spawnSync('npm', ['root', '-g'], {
    shell: true,
    encoding: 'utf8',
  });
  if (npmRoot.status === 0) {
    const entry = join(
      npmRoot.stdout.trim(),
      '@tobilu',
      'qmd',
      'dist',
      'cli',
      'qmd.js'
    );
    if (existsSync(entry)) return entry;
  }

  return null;
}

const entry = resolveQmdEntry();
const qmdArgs = ['mcp', ...process.argv.slice(2)];

const [cmd, args] = entry
  ? [process.execPath, [entry, ...qmdArgs]]
  : ['qmd', qmdArgs];

const child = spawn(cmd, args, {
  stdio: 'inherit',
  shell: !entry,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
