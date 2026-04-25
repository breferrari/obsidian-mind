/**
 * obsidian-mind post-update hook.
 *
 * Runs after `shardmind update` finishes applying merge results and writes
 * new state. Non-fatal — warnings in the summary, no rollback.
 *
 * For v6, update-time side effects are minimal: the vault structure stays
 * stable across patch / minor bumps, and QMD's index is kept fresh by the
 * PostToolUse `qmd-refresh.ts` hook during editing sessions rather than at
 * install or update time. If a future migration requires a re-bootstrap,
 * branch here on `ctx.previousVersion`.
 */

// Local mirror of ShardMind's HookContext shape. See post-install.ts for the
// rationale (no shardmind dep; types erased at runtime).
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

export default async function postUpdate(ctx: HookCtx): Promise<void> {
  const prev = ctx.previousVersion ?? 'unknown';
  console.log(`obsidian-mind: updated from ${prev} to ${ctx.shard.version}.`);

  if (ctx.values['qmd_enabled'] === true) {
    console.log('qmd: index stays fresh via the PostToolUse refresh hook during sessions — no action needed here.');
  }
}
