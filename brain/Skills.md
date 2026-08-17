---
date: 2026-04-07
description: "Vault-specific workflows and slash commands — reusable patterns for review prep, project tracking, and vault maintenance"
tags:
  - brain
  - index
---

# Skills

Custom slash commands, subagents, and reusable workflows. Defined in `.claude/commands/` and `.claude/agents/`. **This note is the canonical command catalog** for agents that don't get the in-session skills injection (Codex, Gemini, Cursor) — keep it current when commands change; CLAUDE.md deliberately carries no command table.

## Slash Commands

### Daily Workflow

| Command | Purpose |
|---------|---------|
| `/om-standup` | Morning kickoff — load context, review yesterday, surface tasks, identify priorities |
| `/om-dump` | Freeform capture — dump anything, gets routed to the right notes automatically |
| `/om-wrap-up` | Full session review — verify notes, indexes, links, suggest improvements. Auto-triggered on "wrap up". |

### Editing & Synthesis

| Command | Purpose |
|---------|---------|
| `/om-humanize` | Voice-calibrated editing — makes Claude-drafted text sound like you wrote it |
| `/om-weekly` | Weekly synthesis — cross-session patterns, North Star alignment, uncaptured wins |

### Meeting Prep & Capture

| Command | Purpose |
|---------|---------|
| `/om-prep-1on1` | Prep for an upcoming 1:1 — load person context, open items, wins to share, suggested agenda |
| `/om-capture-1on1` | Capture 1:1 meeting transcript into structured vault note with quotes, action items, DM context |
| `/om-incident-capture` | Capture incident from Slack channels/DMs into structured vault notes — timeline, people, analysis, brag entry |
| `/om-slack-scan` | Deep scan Slack channels/DMs for evidence — extracts timestamped touchpoints, organizes by context |
| `/om-meeting` | Prep for any meeting by topic — subject-forward briefing with open items, blockers, and brainstormed considerations |
| `/om-intake` | Process meeting notes inbox — classify raw exports in `work/meetings/` and route to the right vault notes |

### Performance & Review

| Command | Purpose |
|---------|---------|
| `/om-peer-scan` | Deep scan a peer's GitHub PRs for review prep — produces structured analysis saved to `perf/evidence/` |
| `/om-review-brief` | Generate review brief (manager or peer version) from vault data |
| `/om-self-review` | Write self-assessment for review tool — projects, competencies, principles |
| `/om-review-peer` | Write peer review — projects, principles, performance summary |

### Vault Maintenance

| Command | Purpose |
|---------|---------|
| `/om-correct` | Sweep a corrected fact through the vault — semantic + literal search, applies at the single source, replaces restatements with links, preserves notes recording what was believed at the time. The acting half of Write-Correctness Law 2 |
| `/om-vault-audit` | Deep structural audit — indexes, frontmatter, links, Bases, folder placement, stale context |
| `/om-vault-upgrade` | Import content from an existing vault — detects version, classifies notes, transforms frontmatter, rebuilds indexes |
| `/om-project-archive` | Move completed project from `work/active/` to `work/archive/YYYY/`, update all indexes — moves whole `active/<Topic>/` clusters intact |
| `/om-tidy` | Self-maintenance pass — acts on every hygiene flag: archives completed work, groups clusters, splits oversized notes, reports open loops. Never deletes, never commits |

## Usage Notes

**Daily:**
- `/om-standup` replaces the manual session start — reads North Star, active work, tasks, git log
- `/om-dump` processes freeform text and routes each piece to the correct note type and folder
- `/om-wrap-up` is auto-triggered when you say "wrap up" — runs full session review

**Editing & Synthesis:**
- `/om-humanize` calibrates against your actual writing samples, not a word blacklist. Detects context from frontmatter (review → corporate-confident, incident → precise, 1:1 → conversational). Run after drafting any note to make it sound human.
- `/om-weekly` bridges standup and review brief — run at end of week for cross-session patterns, North Star drift, and uncaptured wins. Output is transient by default; offer to promote findings to brag doc or North Star.

**Capture:**
- `/om-capture-1on1` handles transcripts, raw notes, or summaries
- `/om-incident-capture` takes Slack URLs and produces structured incident documentation
- `/om-slack-scan` should be run AFTER `/om-peer-scan` to add context beyond code (leadership, communication, collaboration evidence)

**Performance:**
- `/om-peer-scan` works best when launched as parallel agents (one per person)
- `/om-review-brief` needs the private brief to exist first — it generates filtered versions from it

**Maintenance:**
- `/om-vault-audit` should be run at the end of substantial sessions — catches stale indexes and mixed context
- `/om-vault-upgrade` imports content from an existing vault (older obsidian-mind or any Obsidian vault). Detects version, classifies notes, transforms frontmatter, fixes wikilinks, rebuilds indexes. Use `--dry-run` to preview.
- `/om-project-archive` handles the active/ → archive/ move with index updates

## Subagents

| Agent | Purpose | Invoked by |
|-------|---------|------------|
| `brag-spotter` | Proactively finds uncaptured wins and competency gaps | `/om-wrap-up`, `/om-weekly` |
| `context-loader` | Loads all vault context about a person, project, incident, or concept | Direct — "load context on X" |
| `cross-linker` | Finds missing wikilinks, orphans, broken backlinks across the vault | `/om-vault-audit` |
| `people-profiler` | Bulk create/update person notes from Slack profiles | `/om-incident-capture` |
| `review-prep` | Aggregates all performance evidence for a given review period | `/om-review-brief` |
| `slack-archaeologist` | Full Slack reconstruction — reads every message, thread, profile, produces unified timeline | `/om-incident-capture` |
| `vault-librarian` | Deep vault maintenance — orphan detection, broken links, frontmatter validation, stale notes | `/om-vault-audit` |
| `review-fact-checker` | Verify every claim in a review draft against vault sources | `/om-self-review`, `/om-review-peer` |
| `vault-migrator` | Classify, transform, and migrate content from a source vault | `/om-vault-upgrade` |

Subagents run in isolated context windows via `.claude/agents/`. They don't pollute the main conversation.

## Hooks

| Hook | When | What |
|------|------|------|
| SessionStart | On startup/resume | QMD re-index, inject North Star, active work, recent changes, tasks, file listing |
| UserPromptSubmit | Every message | Classify content (decision, incident, 1:1, win, architecture, person, project update) and inject routing hints |
| PostToolUse | After writing `.md` | Validates frontmatter, checks for wikilinks |
| PreCompact | Before context compaction | Back up session transcript to `thinking/session-logs/` |
| Stop | End of session | Checklist: archive, update indexes, check orphans |

## Semantic Search (QMD)

If QMD is installed (`npm install -g @tobilu/qmd`), the vault has semantic search. Every command takes `--index <name>`, where `<name>` is `vault-manifest.json`'s `qmd_index` field when set and otherwise the vault folder name slugified:

- `qmd --index <name> query "..."` — hybrid BM25 + vector + LLM reranking (best quality)
- `qmd --index <name> search "..."` — fast BM25 keyword search
- `qmd --index <name> vsearch "..."` — semantic vector search (exploratory)
- `qmd --index <name> update && qmd --index <name> embed` — refresh index after bulk changes

SessionStart hook runs `qmd --index <name> update` automatically, reading the index name from the manifest. First-time setup on a fresh clone: `node --experimental-strip-types .scripts/qmd-bootstrap.ts`. See `.claude/skills/qmd/SKILL.md` for full reference, and [[Memories]] for the topics QMD is most often asked to find across the vault.

## The `om` MCP Server (reaching this vault from another repo)

`.claude/scripts/om-mcp.mjs` exposes this vault over MCP so a session in **another repository** can use it. Registered in the *consuming* project's `.mcp.json`, never in this vault's own — the server refuses a memory write from a session running inside the vault, because such a memory would be scoped to the vault-as-a-project and reach only sessions that already read every note directly.

| tool | purpose |
|------|---------|
| `search` | semantic + keyword over the notes this vault serves |
| `expand` | a note's links out and backlinks |
| `recall` | durable lessons scoped to the calling repo, most specific first; `explain: true` reports what was withheld and why. A capture whose `promoted:` marker carries an anchor serves the promoted `brain/` block instead of the capture body, so you read the corrected version |
| `remember` | record a lesson that generalises beyond this repo |
| `record_work` | record what happened here, filed where it belongs |
| `reason` | judgement across several notes, by reading the vault with a second Claude session |
| `health` | where memories live, which roots are exposed, is the index reachable |

Two prompts you invoke yourself from the `/` menu: `recall_topic`, `prior_art`. They must be **selected** from the menu — typing the displayed label errors.

**`reason` is the slow one.** The rest answer without inference; this one spawns a session, so it takes seconds to minutes. Reach for it when `search` or `recall` returned the notes but not the answer — it seeds itself from search, so there is no need to search first. It runs on your own CLI default model unless `reason.model` pins one, nothing about it is capped, and every call is logged with its cost, turns, model and wall time. Answers land in `.claude/om-reasoning/` marked `confidence: inferred` and are never auto-recorded as memories.

**Debugging it:** call `health` first. Every failure in this layer presents identically as "no results" — a renamed memory folder, a moved launcher, an index registered to a different vault, a session with no identity — and `health` is what tells them apart. A caller reported as `ANONYMOUS` means the client never completed the roots handshake, so only `general`-scope memories are visible.

**Two guards worth knowing:** memories are never served as ordinary notes (they carry their own declared scope), and a memory that would reach nobody is refused rather than silently widened to `general`.

Full setup, which notes the server serves, and the required repo-side snippet: `CLAUDE.md` § *Reaching the Vault From Another Repo*. How the whole layer works — the four MCP surfaces, the identity handshake, a `search` call end to end, memory-visibility evaluation, the write path: `ARCHITECTURE.md` § *Reaching the Vault From Another Repo*.

## Workflow: Weekly Review

1. **`/om-weekly`** — synthesize the week's activity, check alignment, find patterns
2. Promote any uncaptured wins to brag doc
3. Update North Star if focus shifted
4. **`/om-wrap-up`** — close the session cleanly

## Workflow: Full Review Cycle Prep

1. **`/om-review-brief manager`** — generate the manager context transfer doc
2. **`/om-review-brief peers`** — generate the peer context transfer doc
3. **`/om-peer-scan`** (parallel, one per peer) — deep scan each peer's PRs
4. **`/om-slack-scan`** — scan relevant channels for your own evidence + peer context
5. **`/om-capture-1on1`** — capture the review 1:1 with your manager
6. **`/om-vault-audit`** — tidy up after all the new data

## Workflow: Project Ramp-Up

1. **`/om-slack-scan`** — scan project channels for history and decisions
2. **`/om-peer-scan`** (if needed) — understand what teammates have already built
3. Create work note from gathered context
4. **`/om-vault-audit`** — ensure everything links properly
