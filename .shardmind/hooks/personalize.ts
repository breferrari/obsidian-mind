/**
 * obsidian-mind personalize hook.
 *
 * Runs on first install + adopt ONLY, and only when the user supplied non-default
 * values — the engine refuses to call `personalize` on an all-defaults install
 * (Invariant 2: a defaults-only install must stay byte-equivalent to `git clone`).
 * That gate is now engine-enforced, so this hook carries no `valuesAreDefaults`
 * check of its own. See ShardMind docs/AUTHORING.md §Hook lifecycle.
 *
 * Writes *managed* files only — the engine warns if a personalize hook creates
 * an unmanaged path. The engine re-hashes managed files after the hook exits, so
 * state.json reflects the post-edit content. Non-fatal: throwing surfaces as a
 * warning in the install summary, never rolls back the install.
 *
 * Responsibility: personalize the managed `brain/North Star.md` heading with the
 * user's name. The empty-`user_name` guard stays in the hook — a user can drive
 * the install non-default via some other value (e.g. `org_name`) while leaving
 * their name blank, and `# North Star — ` would be an eyesore.
 *
 * `personalizeNorthStar` is exported by name so the test suite can drive it with
 * synthetic vault layouts.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Local mirror of ShardMind's PersonalizeContext shape. Inlined (rather than
// imported from `shardmind/runtime`) so obsidian-mind has no shardmind
// dependency — the engine's hook runner spawns this file via tsx and the types
// are erased at runtime. Kept in sync with `source/runtime/types.ts::PersonalizeContext`
// in the shardmind repo. Personalize runs on first install/adopt only, so it
// receives no `previousVersion`, no `newFiles`/`removedFiles`, and — crucially —
// no `valuesAreDefaults`: if this hook runs, values are non-default by
// construction. See ShardMind docs/AUTHORING.md §Per-slot context shapes.
interface PersonalizeContext {
  slot: 'personalize';
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
}

export default async function personalize(ctx: PersonalizeContext): Promise<void> {
  // The engine only reaches this hook when values are non-default, so no
  // `valuesAreDefaults` check is needed. The empty-name guard remains: a
  // non-default `org_name` (or any other value) with a blank `user_name` must
  // still leave North Star untouched rather than write `# North Star — `.
  const userName = typeof ctx.values['user_name'] === 'string' ? ctx.values['user_name'] : '';
  if (userName.trim().length > 0) {
    await personalizeNorthStar(ctx.vaultRoot, userName);
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
