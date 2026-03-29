# Vault Upgrade

Import and migrate content from an existing Obsidian vault into this obsidian-mind instance. Works with older obsidian-mind versions and arbitrary Obsidian vaults.

**When to use**: After downloading or cloning the latest obsidian-mind template, to pull in your existing vault content. Also works for migrating any Obsidian vault into the obsidian-mind structure.

## Usage

```
/vault-upgrade <path-to-source-vault>
/vault-upgrade <path-to-source-vault> --dry-run
/vault-upgrade --source <path-to-source-vault>
/vault-upgrade --source <path-to-source-vault> --dry-run
```

**Arguments**:
- `<path-to-source-vault>` — absolute or relative path to the vault to migrate FROM (positional or via `--source`)
- `--dry-run` — generate the migration plan without executing it (saves to `thinking/`)

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

If `brain/Migration Log.md` exists in the target vault, read it and extract content hashes. For each source file, compute its hash and compare:
- Hash matches existing target file → **SKIP** (already migrated, unchanged)
- Source hash differs from log → **FLAG** (source modified since last migration — ask user)
- No entry in log → process normally (new file)

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

  ⚠ 3 orphan notes (no inbound links) — run /vault-audit to fix
  ⚠ 5 files in thinking/migrate-review/ need manual sorting

  Migration log: brain/Migration Log.md
```

Offer next steps:
- "Run `/vault-audit` for a full structural check"
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
