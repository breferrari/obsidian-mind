# Vault Upgrade

Two jobs, picked by whether a source vault is given:

- **No source: upgrade THIS vault** to the latest template release, through [ShardMind](https://github.com/breferrari/shardmind), keeping every local improvement. See *Upgrade this vault* below.
- **A source vault: import its content** into this obsidian-mind instance. Works with older obsidian-mind versions and arbitrary Obsidian vaults. See *Workflow* below.

## Usage

```
/om-vault-upgrade                                   # upgrade this vault (ShardMind)
/om-vault-upgrade --dry-run                         # show the upgrade plan only
/om-vault-upgrade <path-to-source-vault>            # import another vault's content
/om-vault-upgrade <path-to-source-vault> --dry-run
/om-vault-upgrade --source <path-to-source-vault> [--dry-run]
```

**Arguments**:
- `<path-to-source-vault>` — absolute or relative path to the vault to migrate FROM (positional or via `--source`)
- `--dry-run` — produce the plan without changing anything

## Upgrade this vault (ShardMind)

ShardMind owns the engine lifecycle: `shardmind update` moves a managed vault to a new release, and `shardmind adopt` brings a vault that was cloned without it under management. This command owns the judgment ShardMind's bulk modes cannot make: whether a file that differs from the template is one **you improved** (keep it, and maybe upstream it) or one **you never updated** (take the new version). A blunt use-all-theirs downgrades every local enhancement. A blunt keep-all-mine is worse: it records stale files as yours, so the vault reports itself up to date while those files stay old and no later update touches them.

**Requires ShardMind 0.2.0 or later** (`shardmind --version`; upgrade with `npm i -g shardmind@latest`). Without ShardMind, use *Workflow* below with this vault's previous copy as the source.

### U1. Plan

```bash
node --experimental-strip-types .claude/scripts/upgrade-plan.ts
```

It never changes the vault. It detects which case this is:

- **Managed** (`.shardmind/state.json` exists): it reads `shardmind --json` and `shardmind update --dry-run --json`.
- **Cloned without ShardMind** (a `vault-manifest.json` but no state, including an incomplete adoption): the release the vault came from is the manifest's `version`. It reads `shardmind adopt … --from-version <v> --dry-run --yes --json` and hashes each differing file against that release.
- **Neither:** not an obsidian-mind vault; use *Workflow* below.

It then prints every file needing judgment, sorted into:

| Section | Meaning | What happens |
|---|---|---|
| **Behind** | The template changed it; you never did | Take the new version. Nothing of yours is lost |
| **Ahead** | Changed only in this vault | Keep yours. List it to the user as an **upstream candidate** if it is an improvement |
| **Merged** | Changed on both sides, merged cleanly | Show the user the result to review |
| **Conflicts** | Changed on both sides, or a new template file where you already have one | The user decides per file |
| **New in the template** | Added | Taken as is |

Show the report to the user. With `--dry-run`, stop here.

### U2. Apply

ShardMind executes only through its terminal UI (`--json` works with `--dry-run` only), so run it non-interactively: `CI=true … --yes < /dev/null`.

**Managed vault:**
- **No conflicts:** `CI=true shardmind update --yes < /dev/null`. `--yes` auto-keeps your version wherever both sides changed, so it is safe only once the plan shows no conflicts.
- **Conflicts:** ask the user to run `! shardmind update` themselves and decide each conflicting file in the prompt, or in their editor.

**Cloned without ShardMind:**
1. Write the new release's bytes for the **behind** files only. Each is checked against adopt's plan before it is written, so nothing you changed is touched:
   ```bash
   node --experimental-strip-types .claude/scripts/upgrade-plan.ts --apply-behind
   ```
2. **No conflicts:** `CI=true shardmind adopt github:breferrari/obsidian-mind --from-version <v> --mode keep-all-mine --yes < /dev/null`. Every file that still differs is now really yours.
3. **Conflicts:** have the user run `! shardmind adopt github:breferrari/obsidian-mind --from-version <v> --mode decide-per-file` instead.

### U3. Verify

1. `shardmind --json` reports the new version, with `update.kind` `up-to-date`. Its `files.modified` must be exactly the **ahead** files, plus any conflicts the user kept. A behind file listed there was frozen, so fix it before finishing.
2. The hooks run: `echo '{}' | node --experimental-strip-types .claude/scripts/session-start.ts` exits 0 and prints the session context.
3. Report the **ahead** files to the user as upstream candidates. A local improvement every vault could use belongs upstream, where the next release carries it.

## Subagents

- **`vault-migrator`** — classifies files (for arbitrary vaults) and executes the approved migration plan

## Workflow

### 1. Validate & Detect

1. Parse the source vault path from the user's input. Resolve relative paths.
2. Verify the source path exists and is different from the current vault.
3. Verify the source path contains `.md` files (is it actually a vault?).
4. Check for `vault-manifest.json` in the source:
   - **Found**: read version directly. This is a known obsidian-mind vault.
   - **Not found**: run version fingerprint detection from the target's `vault-manifest.json`:
     - Check for `claude/Memories.md` without `brain/` → v1
     - Check for `brain/` + `bases/` without `.claude/agents/` → v2
     - Check for `.claude/agents/` → v3.x (refine by checking for specific files)
     - None match → **arbitrary vault** (not from obsidian-mind)
5. For arbitrary vaults, also detect the vault's **organizational pattern** (PARA, Zettelkasten, daily notes, flat, MOC-based, inbox). This shapes how the classifier interprets folder structure. Common patterns:
   - **PARA**: `Projects/` + `Areas/` + `Resources/` + `Archive/`
   - **Zettelkasten**: `Permanent/` + `Fleeting/` + `Literature/`, or many numeric-ID filenames
   - **Daily Notes**: `daily/` or `journal/` folder with date-named files
   - **Flat**: 80%+ of files in vault root
   - **MOC-based**: files named `MOC - *.md` or `Index - *.md`
6. Report detection result to the user: "Detected obsidian-mind v2" or "This looks like a PARA-organized Obsidian vault — I'll map Projects → work/active, Resources → reference, etc." or "This is a flat vault with no folder structure — I'll classify each note by its content."

### 2. Inventory & Classify

Read `vault-manifest.json` from the target (this vault) to know the infrastructure/scaffold/user_content classification rules.

**For obsidian-mind source vaults:**

Glob all `.md`, `.base`, `.canvas` files and binary files (images, PDFs) in the source vault. For each file, classify deterministically:

| Source matches | Action | Target |
|----------------|--------|--------|
| `infrastructure` glob (but check exceptions below FIRST — MERGE takes precedence over SKIP) | **SKIP** | Template already has latest |
| `.gitignore` | **MERGE** | Keep template rules, append any user-added entries, log before/after diff |
| `bases/**` | **MERGE** | Keep template Bases, preserve user-added Bases, log conflicts for review |
| `.claude/commands/` not in template | **MERGE** | `.claude/commands/` (user addition) |
| `.claude/agents/` not in template | **MERGE** | `.claude/agents/` (user addition) |
| `.claude/scripts/` not in template | **MERGE** | `.claude/scripts/` (user addition) |
| `scaffold` path with real content | **REPLACE** | Same path in target |
| `scaffold` path with stub-only content | **SKIP** | Template stub is fine |
| `user_content_roots` glob | **COPY** | Same relative path |
| `.obsidian/` config files | **CONFIG** | `.obsidian/` (see config merge rules) |
| Binary files in user content roots | **COPY** | Same relative path |
| Everything else | **SKIP** | Log as skipped |

Detect scaffold "real content" by checking if the file has more than 5 lines of non-YAML, non-heading content beyond the template stub.

**For arbitrary vaults:**

1. Glob all `.md` files in the source vault (exclude `.obsidian/`, `node_modules/`, `.git/`, `.trash/`)
2. Also glob binary files (images: `*.png`, `*.jpg`, `*.svg`, `*.gif`; documents: `*.pdf`; other: `*.canvas`, `*.base`) — these are attachments that may be embedded in notes
3. Run Tier 0 (vault shape detection) to understand the organizational pattern
4. Attempt Tier 1 (structural) and Tier 2 (metadata — both YAML frontmatter and inline tags/Dataview fields) classification locally
5. For files that remain unclassified, launch the **vault-migrator** agent in **classification mode** — it reads content and applies Tier 3/4 heuristics. The agent classifies notes into work categories (work, person, incident, 1:1, decision, competency, reference) but also recognizes non-work content (personal, learning, journal) and routes it to appropriate locations (`reference/personal/`, `reference/learning/`)
6. Incorporate the agent's classification map into the inventory
7. Notes with no YAML frontmatter will have frontmatter generated during execution (date, description, tags derived from content and inline signals)

**Idempotency check:**

If `brain/Migration Log.md` exists in the target vault, read it and extract the recorded hashes. Each log entry stores both a **source hash** (original file content) and a **final hash** (transformed content written to target).

On re-run, compute the **source hash** for each source file and compare against the logged source hash:
- Source hash matches for the same source path → **SKIP** (already migrated, unchanged)
- Entry exists but source hash differs → **FLAG** (source modified since last migration — ask user)
- No entry for this source path → process normally (new file)

### 3. Present Migration Plan

Build and present a structured plan to the user. This is the critical decision point — nothing executes without approval.

**Summary section:**
```
Source: ~/my-vault (obsidian-mind v2)
Target: this vault (obsidian-mind v3.3)

Files found: 87
  COPY:     52 user content files
  REPLACE:   6 scaffold files with real content
  MERGE:     2 custom commands
  CONFIG:    4 .obsidian/ files
  SKIP:     18 infrastructure files (template has latest)
  CLASSIFY:  5 uncategorized → thinking/migrate-review/

Transformations:
  - 23 notes missing 'quarter' field (will derive from date)
  - 12 notes missing 'description' field (will generate)
  - 3 notes with alias field → normalize to 'ticket'
  - 1 v1 monolith Memories.md → split into topic files
```

**Detailed table** (show first 20, offer to show all):
```
| # | Source | Target | Action | Transforms |
|---|--------|--------|--------|------------|
| 1 | org/people/Jane.md | org/people/Jane.md | COPY | +description |
| 2 | brain/Memories.md | brain/Memories.md | REPLACE | — |
| 3 | daily/2026-03-15.md | work/1-1/... | CLASSIFY+COPY | +quarter, +tags |
```

**Conflict section** (if any):
```
⚠ Conflicts requiring your input:
  - source has customized CLAUDE.md (will NOT copy — differences logged)
  - source has .claude/commands/my-custom.md (will MERGE as user addition)
```

Ask the user: "Does this plan look right? You can modify it — tell me to skip files, change targets, or adjust transformations. Say 'go' to execute."

**For `--dry-run`**: write the plan to `thinking/vault-upgrade-plan-YYYY-MM-DD.md` and stop.

### 4. Execute Migration

Once the user approves, launch the **vault-migrator** agent in **execution mode** with:
- Source vault path
- The approved migration plan
- The target vault's manifest

The agent handles all file operations: read from source, transform, write to target, rebuild indexes, copy .obsidian/ config, write migration log.

Wait for the agent to complete. If it reports errors, present them to the user.

### 5. Validate

After the agent completes:

1. Glob all newly created files in the target vault
2. Spot-check frontmatter on 5 random migrated files (read and verify required fields)
3. Check for broken wikilinks in migrated files (grep for `[[` patterns, verify targets exist)
4. Verify index files reference the migrated content
5. Count orphan notes (notes with zero inbound links)
6. Report results:

```
Migration complete.
  ✓ 52 files migrated
  ✓ 6 scaffold files replaced
  ✓ 2 custom commands merged
  ✓ Indexes rebuilt (work/Index.md, People & Context, Brag Doc, Memories)
  ✓ .obsidian/ config copied

  ⚠ 3 orphan notes (no inbound links) — run /om-vault-audit to fix
  ⚠ 5 files in thinking/migrate-review/ need manual sorting

  Migration log: brain/Migration Log.md
```

Offer next steps:
- "Run `/om-vault-audit` for a full structural check"
- "Review `thinking/migrate-review/` for uncategorized files"
- "Check `brain/Migration Log.md` for the full receipt and CLAUDE.md diff"

## Important

- **The source vault is NEVER modified.** All operations are read-only on the source, write-only on the target.
- **Plan-first, always.** Never skip the plan presentation step, even if the migration looks simple.
- **Preserve user curation.** When rebuilding indexes, start from the source's version (which has the user's ordering and groupings), then append missing entries. Don't regenerate from scratch.
- **CLAUDE.md is special.** Never copy it from the source. The template's CLAUDE.md is always authoritative. If the source has customizations, diff them and log the differences so the user can re-apply manually.
- **Binary files matter.** Images, PDFs, and attachments embedded in notes must be copied or the embeds break.
- **Wikilinks resolve by filename.** Most folder moves don't break links. Only renames and full-path links need fixing.
- **Markdown links get converted.** Standard markdown links to local files (`[text](path.md)`) are converted to wikilinks (`[[name|text]]`). External URLs are left as-is.
- **Non-work content is welcome.** Not every note fits work/org/perf. Personal journal entries go to `reference/personal/`, book and course notes go to `reference/learning/`. The goal is zero data loss, not forcing everything into work categories.
- **No frontmatter is fine.** Many Obsidian vaults don't use YAML frontmatter. The migrator generates it from inline tags, Dataview fields, filenames, and content analysis.
- This command creates `thinking/migrate-review/` only if there are uncategorized files. Clean it up after manual sorting.
