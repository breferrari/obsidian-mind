/**
 * obsidian-mind post-update hook.
 *
 * Runs after `shardmind update` finishes applying merge results and writes
 * new state. Non-fatal — warnings in the summary, no rollback.
 *
 * For v6, update-time side effects are minimal:
 *
 *   * Vault structure stays stable across patch / minor bumps. No managed
 *     file needs personalization on update — the post-install hook handled
 *     that once at install time, and the user's edits since then are owned
 *     by the user (and protected by the merge engine).
 *   * QMD's index is kept fresh by the PostToolUse `qmd-refresh.ts` hook
 *     during editing sessions, not at install/update time. A re-bootstrap
 *     here would clobber the user's existing index for no benefit.
 *
 * Invariant 3 (post-update hooks are additive-only by default — see
 * ShardMind docs/SHARD-LAYOUT.md §Invariant 3): a hook that needs to write
 * a managed file MUST restrict its writes to paths in `ctx.newFiles`. This
 * hook writes nothing today, so the contract holds trivially. If a future
 * migration ships a new managed file that the hook needs to seed, the
 * write must be guarded on `ctx.newFiles.includes(path)`.
 *
 * If a future migration requires a re-bootstrap, branch on
 * `ctx.previousVersion` here.
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

  // Invariant 3: no managed-file writes from this hook today. If you add
  // one, gate it on `ctx.newFiles.includes(<path>)` so the engine's
  // additive-only contract is preserved. `ctx.removedFiles` is available
  // for cleaning up external state (QMD collection refs, MCP registrations)
  // that referenced now-removed paths — but obsidian-mind doesn't track
  // any such external pointers from the engine side.
}
