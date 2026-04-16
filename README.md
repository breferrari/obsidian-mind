🌐 **English** | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [한국어](README.ko.md)

<p align="center">
  <img src="obsidian-mind-logo.png" alt="Obsidian Mind" width="120">
</p>

<h1 align="center">Obsidian Mind</h1>

[![Claude Code](https://img.shields.io/badge/claude%20code-full%20support-D97706)](https://docs.anthropic.com/en/docs/claude-code)
[![Codex CLI](https://img.shields.io/badge/codex%20cli-hooks%20%2B%20commands-10A37F)](https://github.com/openai/codex)
[![Gemini CLI](https://img.shields.io/badge/gemini%20cli-hooks%20%2B%20commands-4285F4)](https://github.com/google-gemini/gemini-cli)
[![Obsidian](https://img.shields.io/badge/obsidian-1.12%2B-7C3AED)](https://obsidian.md)
[![Obsidian CLI](https://img.shields.io/badge/obsidian--cli-integrated-E6E6E6)](https://github.com/kepano/obsidian-cli)
[![Obsidian Skills](https://img.shields.io/badge/obsidian--skills-integrated-8B5CF6)](https://github.com/kepano/obsidian-skills)
[![QMD](https://img.shields.io/badge/qmd-semantic%20search-FF6B6B)](https://github.com/tobi/qmd)
[![Node](https://img.shields.io/badge/node-22%2B-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **An Obsidian vault that gives AI coding agents persistent memory.** Built for Claude Code, with working hooks for Codex CLI and Gemini CLI. Start a session, talk about your day, and the agent handles the rest — notes, links, indexes, performance tracking. Every conversation builds on the last.

---

## 🔴 The Problem

AI coding agents are powerful, but they forget. Every session starts from zero — no context on your goals, your team, your patterns, your wins. You re-explain the same things. You lose decisions made three conversations ago. The knowledge never compounds.

## 🟢 The Solution

Give your agent a brain.

```
You: "start session"
Agent: *reads North Star, checks active projects, scans recent memories*
Agent: "You're working on Project Alpha, blocked on the BE contract.
        Last session you decided to split the coordinator. Your 1:1
        with your manager is tomorrow — review brief is ready."
```

Works with **Claude Code** (full support), **Codex CLI**, and **Gemini CLI** — same hooks, same commands, same vault.

---

## ⚡ See It In Action

<p align="center">
  <img src="obsidian-mind-demo.gif" alt="Obsidian Mind demo — standup and dump commands" width="800">
</p>

**Morning kickoff:**

```bash
/om-standup
# → loads North Star, active projects, open tasks, recent git changes
# → "You have 2 active projects. The auth refactor is blocked on API contract.
#    Your 1:1 with Sarah is at 2pm — last time she flagged observability."
```

**Brain dump after a meeting:**

```bash
/om-dump Just had a 1:1 with Sarah. She's happy with the auth work but wants
us to add error monitoring before release. Also, Tom mentioned the cache
migration is deferred to Q2 — we decided to focus on the API contract first.
Decision: defer Redis migration. Win: Sarah praised the auth architecture.
```

```
→ Updated org/people/Sarah Chen.md with meeting context
→ Created work/1-1/Sarah 2026-03-26.md with key takeaways
→ Created Decision Record: "Defer Redis migration to Q2"
→ Added to perf/Brag Doc.md: "Auth architecture praised by manager"
→ Updated work/active/Auth Refactor.md with error monitoring task
```

**Incident response:**

```bash
/om-incident-capture https://slack.com/archives/C0INCIDENT/p123456
# → slack-archaeologist reads every message, thread, and profile
# → people-profiler creates notes for new people involved
# → Full timeline, root cause analysis, brag doc entry
```

**End of day:**

```
You: "wrap up"
# → verifies all notes have links
# → updates indexes
# → brag-spotter finds uncaptured wins
# → suggests improvements
```

---

## 🚀 Quick Start

1. Clone this repo (or use it as a **GitHub template**)
2. Open the folder as an **Obsidian vault**
3. Enable the **Obsidian CLI** in Settings → General (requires Obsidian 1.12+)
4. Run your agent in the vault directory: **`claude`**, **`codex`**, or **`gemini`**
5. Fill in **`brain/North Star.md`** with your goals — this grounds every session
6. Start talking about work

### 🔍 Optional: QMD Semantic Search

For semantic search across the vault (find "what did we decide about caching" even if the note is titled "Redis Migration ADR"):

```bash
npm install -g @tobilu/qmd
qmd collection add . --name vault --mask "**/*.md"
qmd context add qmd://vault "Engineer's work vault: projects, decisions, incidents, people, reviews, architecture"
qmd update && qmd embed
```

> [!NOTE]
> If QMD isn't installed, everything still works — the agent falls back to the Obsidian CLI and grep.

---

## 📋 Requirements

- [Obsidian](https://obsidian.md) 1.12+ (for CLI support)
- An AI coding agent: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (full support), [Codex CLI](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Node 22+ LTS](https://nodejs.org) (for hook scripts — typically already installed alongside Claude Code / Codex / Gemini CLI)
- Git (for version history)
- [QMD](https://github.com/tobi/qmd) (optional, for semantic search)

---

## ⚙️ How It Works

**Folders group by purpose. Links group by meaning.** A note lives in one folder (its home) but links to many notes (its context). Your agent maintains this graph — linking work notes to people, decisions, and competencies automatically. When review season arrives, the backlinks on each competency note are already the evidence trail. A note without links is a bug.

**Vault-first memory** keeps context across sessions and machines. All durable knowledge lives in `brain/` topic notes (git-tracked, Obsidian-browsable, linked). Claude Code's `MEMORY.md` (`~/.claude/`) is an auto-loaded index that points to vault locations — never the storage itself. This means memories survive machine changes and are part of the graph.

**Sessions have a designed lifecycle.** The `SessionStart` hook auto-injects your North Star goals, active projects, recent changes, open tasks, and the full vault file listing — your agent starts every session with context, not a blank slate. At the end, say "wrap up" and the agent runs `/om-wrap-up` — verifying notes, updating indexes, and spotting uncaptured wins. The `CLAUDE.md` operating manual governs everything in between: where to file things, how to link, when to split a note, what to do with decisions and incidents.

### 🔗 Hooks

Five lifecycle hooks handle routing automatically:

| Hook | When | What |
|------|------|------|
| 🚀 SessionStart | On startup/resume | QMD re-index, inject North Star, active work, recent changes, tasks, file listing |
| 💬 UserPromptSubmit | Every message | Classifies content (decision, incident, win, 1:1, architecture, person, project update) and injects routing hints |
| ✍️ PostToolUse | After writing `.md` | Validates frontmatter, checks for wikilinks |
| 💾 PreCompact | Before context compaction | Backs up session transcript to `thinking/session-logs/` |
| 🏁 Stop | End of session | Checklist: archive completed projects, update indexes, check orphans |

> [!TIP]
> You just talk. The hooks handle the routing.

### ⚡ Token Efficiency

obsidian-mind does **not** dump your entire vault into context. It uses tiered loading to keep token costs low:

| Tier | What | When | Cost |
|------|------|------|------|
| **Always** | `CLAUDE.md` + SessionStart context (North Star excerpt, git summary, tasks, vault file listing) | Session start | ~2K tokens |
| **On-demand** | QMD semantic search results | When the agent needs specific context | Targeted |
| **Triggered** | Classification routing hints | Every message | ~100 tokens |
| **Triggered** | PostToolUse validation | After `.md` writes | ~200 tokens |
| **Rare** | Full file reads | Only when explicitly needed | Variable |

SessionStart loads **lightweight context** — small excerpts from key files, filenames, and git summary — not full note contents. The agent queries by meaning via QMD before reading files, so it pulls only what's relevant. The classification hook is one lightweight Node call per message. The validation hook only fires on markdown writes and skips excluded paths.

### 🌐 Using with Other Agents

obsidian-mind works with Claude Code, Codex CLI, and Gemini CLI. The vault conventions in `CLAUDE.md`, the hook scripts in `.claude/scripts/`, and the 18 commands in `.claude/commands/` are all agent-agnostic — pure Markdown, TypeScript, and shell with no SDK dependencies.

**Claude Code** — full support. Hooks, commands, subagents, and the memory system all work out of the box.

**Codex CLI** — reads `AGENTS.md` natively. Hook config at `.codex/hooks.json` wires the same hook scripts Claude Code uses — session context, message classification, and write validation work automatically. Commands work as regular prompts (e.g. type `om-standup` without the `/` prefix).

**Gemini CLI** — reads `GEMINI.md` natively. Hook config at `.gemini/settings.json` maps Gemini's event names to the shared hook scripts.

**Other agents** (Cursor, Windsurf, GitHub Copilot, JetBrains AI) — read `AGENTS.md` for vault conventions. Hook support varies by agent.

> [!NOTE]
> Hooks, commands, subagent prompts, and vault memory (`brain/`) are all agent-agnostic. Only the `~/.claude/` auto-memory loader is Claude Code-specific. See `AGENTS.md` for the full portability guide.

---

## 📅 Daily Workflow

**Morning**: Run `/om-standup`. Your agent loads your North Star, active projects, open tasks, and recent changes. You get a structured summary and suggested priorities.

**Throughout the day**: Talk naturally. Mention a decision you made, an incident that happened, a 1:1 you just had, a win you want to remember. The classification hook nudges the agent to file each piece correctly. For bigger brain dumps, use `/om-dump` and narrate everything at once.

**End of day**: Say "wrap up" and the agent invokes `/om-wrap-up` — verifies notes, updates indexes, checks links, spots uncaptured wins.

**Weekly**: Run `/om-weekly` for cross-session synthesis — North Star alignment, patterns, uncaptured wins, and next-week priorities. Run `/om-vault-audit` to catch orphan notes, broken links, and stale content.

**Review season**: Run `/om-review-brief manager` and get a structured review prep document with all the evidence already linked.

---

## 🛠️ Commands

Defined in `.claude/commands/`. Run them in Claude Code, Codex CLI, or Gemini CLI.

| Command | What It Does |
|---------|-------------|
| `/om-standup` | Morning kickoff — loads context, reviews yesterday, surfaces tasks, suggests priorities |
| `/om-dump` | Freeform capture — talk naturally about anything, routes it all to the right notes |
| `/om-wrap-up` | Full session review — verify notes, indexes, links, suggest improvements |
| `/om-humanize` | Voice-calibrated editing — makes Claude-drafted text sound like you wrote it |
| `/om-weekly` | Weekly synthesis — cross-session patterns, North Star alignment, uncaptured wins |
| `/om-capture-1on1` | Capture a 1:1 meeting transcript into a structured vault note |
| `/om-incident-capture` | Capture an incident from Slack/channels into structured notes |
| `/om-slack-scan` | Deep scan Slack channels/DMs for evidence |
| `/om-peer-scan` | Deep scan a peer's GitHub PRs for review prep |
| `/om-review-brief` | Generate a review brief (manager or peer version) |
| `/om-self-review` | Write your self-assessment for review season — projects, competencies, principles |
| `/om-review-peer` | Write a peer review — projects, principles, performance summary |
| `/om-vault-audit` | Audit indexes, links, orphans, stale context |
| `/om-vault-upgrade` | Import content from an existing vault — version detection, classification, migration |
| `/om-prep-1on1` | Prep for an upcoming 1:1 — load person context, open items, suggested agenda |
| `/om-meeting` | Prep for any meeting by topic — subject-forward briefing with open items and considerations |
| `/om-intake` | Process meeting notes inbox — classify and route to the right vault notes |
| `/om-project-archive` | Move a completed project from active/ to archive/, update indexes |

---

## 🤖 Subagents

Specialized agents that run in isolated context windows. They handle heavy operations without polluting your main conversation.

| Agent | Purpose | Invoked by |
|-------|---------|------------|
| `brag-spotter` | Finds uncaptured wins and competency gaps | `/om-wrap-up`, `/om-weekly` |
| `context-loader` | Loads all vault context about a person, project, or concept | Direct |
| `cross-linker` | Finds missing wikilinks, orphans, broken backlinks | `/om-vault-audit` |
| `people-profiler` | Bulk creates/updates person notes from Slack profiles | `/om-incident-capture` |
| `review-prep` | Aggregates all performance evidence for a review period | `/om-review-brief` |
| `slack-archaeologist` | Full Slack reconstruction — every message, thread, profile | `/om-incident-capture` |
| `vault-librarian` | Deep vault maintenance — orphans, broken links, stale notes | `/om-vault-audit` |
| `review-fact-checker` | Verify every claim in a review draft against vault sources | `/om-self-review`, `/om-review-peer` |
| `vault-migrator` | Classify, transform, and migrate content from a source vault | `/om-vault-upgrade` |

> [!NOTE]
> Subagents are defined in `.claude/agents/`. You can add your own for domain-specific workflows.

---

## 📊 Performance Graph

The vault doubles as a performance tracking system:

1. **Competency notes** in `perf/competencies/` define your org's competency framework — one note per competency
2. **Work notes** link to competencies in their `## Related` section, annotated with what was demonstrated
3. **Backlinks accumulate automatically** — review prep becomes reading the backlinks panel on each competency note
4. **Brag Doc** aggregates wins per quarter with links to evidence notes
5. **`/om-peer-scan`** deep-scans a colleague's GitHub PRs and writes structured evidence to `perf/evidence/`
6. **`/om-review-brief`** generates a full review brief by aggregating everything: brag entries, decisions, incidents, competency evidence, and 1:1 feedback

> [!TIP]
> To get started: create competency notes from the template, then link your work notes to them as you go. The graph does the rest.

---

## 📋 Bases

The `bases/` folder contains database views that query your notes' frontmatter properties. They update automatically as notes change.

| Base | Shows |
|------|-------|
| Work Dashboard | Active projects filtered by quarter, grouped by status |
| Incidents | All incidents sorted by severity and date |
| People Directory | Everyone in `org/people/` with role, team |
| 1:1 History | All 1:1 notes sortable by person and date |
| Review Evidence | PR scans and evidence grouped by person and cycle |
| Competency Map | Competencies with evidence counts from backlinks |
| Templates | Quick access to all templates |

`Home.md` embeds these views, making it the vault's dashboard.

---

## 📁 Vault Structure

```
Home.md                 Vault entry point — embedded Base views, quick links
CLAUDE.md               Operating manual — read by your agent every session
AGENTS.md               Multi-agent guide — Codex, Cursor, Windsurf, etc.
GEMINI.md               Multi-agent guide — Gemini CLI
vault-manifest.json     Template metadata — version, structure, schemas
CHANGELOG.md            Version history
CONTRIBUTING.md         Template development checklist
README.md               Product documentation
LICENSE                 MIT license

bases/                  Dynamic database views (Work Dashboard, Incidents, People, etc.)

work/
  active/               Current projects (1–3 files at a time)
  archive/YYYY/         Completed work, organized by year
  incidents/            Incident docs (main note + RCA + deep dive)
  1-1/                  1:1 meeting notes — named <Person> YYYY-MM-DD.md
  Index.md              Map of Content for all work

org/
  people/               One note per person — role, team, relationship, key moments
  teams/                One note per team — members, scope, interactions
  People & Context.md   MOC for organizational knowledge

perf/
  Brag Doc.md           Running log of wins, linked to evidence
  brag/                 Quarterly brag notes (one per quarter)
  competencies/         One note per competency (link targets)
  evidence/             PR deep scans, data extracts for reviews
  <cycle>/              Review cycle briefs and artifacts

brain/
  North Star.md         Goals and focus areas — read every session
  Memories.md           Index of memory topics
  Key Decisions.md      Significant decisions and their reasoning
  Patterns.md           Recurring patterns observed across work
  Gotchas.md            Things that have gone wrong and why
  Skills.md             Custom workflows and slash commands

reference/              Codebase knowledge, architecture maps, flow docs
thinking/               Scratchpad for drafts — promote findings, then delete
templates/              Obsidian templates with YAML frontmatter

.claude/
  commands/             18 slash commands
  agents/               9 subagents
  scripts/              Hook scripts + charcount.sh utility
  skills/               Obsidian + QMD skills
  settings.json         5 hooks configuration
```

---

## 📝 Templates

Templates with YAML frontmatter, each including a `description` field for progressive disclosure:

- **Work Note** — date, description, project, status, quarter, tags
- **Decision Record** — date, description, status (proposed/accepted/deprecated), owner, context
- **Thinking Note** — date, description, context, tags (scratchpad — delete after promoting)
- **Competency Note** — date, description, current-level, target-level, proficiency table
- **1:1 Note** — date, person, key takeaways, action items, quotes
- **Incident Note** — date, ticket, severity, role, timeline, root cause, impact

---

## 🔧 What's Included

### 🧩 Obsidian Skills

[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) pre-installed in `.claude/skills/`:

- **obsidian-markdown** — Obsidian-flavored markdown (wikilinks, embeds, callouts, properties)
- **obsidian-cli** — CLI commands for vault operations
- **obsidian-bases** — Database-style `.base` files
- **json-canvas** — Visual `.canvas` file creation
- **defuddle** — Web page to markdown extraction

### 🔍 QMD Skill

A custom skill in `.claude/skills/qmd/` that teaches the agent to use [QMD](https://github.com/tobi/qmd) semantic search proactively — before reading files, before creating notes (to check for duplicates), and after creating notes (to find related content that should link to it).

---

## 🎨 Customize It

This is a starting point. Adapt it to how you work:

| What | Where |
|------|-------|
| Your goals | `brain/North Star.md` — grounds every session |
| Your org | `org/` — add your manager, team, key collaborators |
| Your competencies | `perf/competencies/` — match your org's framework |
| Your tools | `.claude/commands/` — edit for your GitHub org, Slack workspace |
| Your conventions | `CLAUDE.md` — the operating manual, evolve it as you go |
| Your domain | Add folders, subagents in `.claude/agents/`, or classification rules in `.claude/scripts/` |

> [!IMPORTANT]
> `CLAUDE.md` is the operating manual. When you change conventions, update it — your agent reads it every session.

---

## 🔄 Upgrading

### Ask your agent

The easiest way — just tell your agent:

```
Update this vault to the latest obsidian-mind from https://github.com/breferrari/obsidian-mind
```

The agent will pull the latest changes, resolve conflicts, and update infrastructure files. Works with Claude Code, Codex CLI, or Gemini CLI.

### Updating an existing clone

If you cloned the repo directly:

```bash
cd your-vault
git pull origin main
```

New files (`AGENTS.md`, `GEMINI.md`, `.codex/`, `.gemini/`) appear automatically and hook scripts are updated in place.

### Updating a fork

If you forked the repo:

```bash
git remote add upstream https://github.com/breferrari/obsidian-mind.git
git fetch upstream
git merge upstream/main
```

Resolve any conflicts in files you customized (typically `CLAUDE.md`, `brain/` notes). Infrastructure files (`.claude/scripts/`, `.codex/`, `.gemini/`) should merge cleanly.

### Migrating from an older vault

Using an older version of obsidian-mind (or any Obsidian vault)? The `/om-vault-upgrade` command migrates your content into the latest template:

```bash
# 1. Clone the latest obsidian-mind
git clone https://github.com/breferrari/obsidian-mind.git ~/new-vault

# 2. Open it in your agent
cd ~/new-vault && claude   # or codex, or gemini

# 3. Run the upgrade pointing to your old vault
/om-vault-upgrade ~/my-old-vault
```

The agent will:
1. **Detect** your vault version (v1–v3.x, or identify it as a non-obsidian-mind vault)
2. **Inventory** every file — classify as user content, scaffold, infrastructure, or uncategorized
3. **Present a migration plan** — you see exactly what will be copied, transformed, and skipped
4. **Execute** after your approval — transforms frontmatter, fixes wikilinks, rebuilds indexes
5. **Validate** — checks for orphans, broken links, missing frontmatter

Your old vault is **never modified**. Use `--dry-run` to preview the plan without executing.

> [!NOTE]
> Works with any Obsidian vault, not just obsidian-mind. For non-obsidian-mind vaults, the agent reads each note and classifies it semantically — routing work notes, people, incidents, 1:1s, and decisions to the right folders.

---

## 🗺️ Roadmap

**Contributions welcome.** Open an issue first for anything bigger than a one-file change. Especially anything that touches the hooks, the install, or what people need installed. Saves you from building something that can't be merged.

---

## 🙏 Design Influences

- [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) — Official Obsidian agent skills
- [James Bedford](https://x.com/jameesy) — Vault structure philosophy, separation of AI-generated content
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — Progressive disclosure via description fields, session hooks

---

## 👤 Author

Created by **[Brenno Ferrari](https://brennoferrari.com)** — Senior iOS Engineer in Berlin, building developer tools with Claude Code.

---

## 📄 License

MIT
