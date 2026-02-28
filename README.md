# Obsidian Mind

An [MCS](https://github.com/bguidolim/MyClaudeSetup) techpack that configures Claude Code for Obsidian vault workflows. Installs skills for Obsidian-flavored markdown, a session hook that gives Claude instant awareness of your vault contents, and scaffolds a vault structure designed for persistent AI context.

## Install

```bash
mcs pack add bguidolim/obsidian-mind
```

## Setup

```bash
mkdir ~/my-vault && cd ~/my-vault
mcs sync    # Select obsidian-mind
```

Then open `~/my-vault` as an Obsidian vault and start your Claude sessions from this folder.

## What Gets Installed

| Component | Description |
|-----------|-------------|
| **5 Obsidian skills** | Markdown, CLI, Canvas, Bases, Defuddle ([kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)) |
| **SessionStart hook** | Lists vault files so Claude knows what exists from turn one |
| **CLAUDE.local.md** | Vault operating instructions — session workflow, linking conventions, note creation rules |
| **Vault scaffold** | `work/`, `claude/`, `perf/`, `thinking/`, `templates/` with starter files |
| **Gitignore entries** | Obsidian runtime state, Claude local settings |

The scaffold script only creates files that don't already exist — it never overwrites your content.

## Requirements

- [Obsidian](https://obsidian.md) 1.12+ (for CLI support)
- [Claude Code](https://claude.ai/claude-code)
- [MCS](https://github.com/bguidolim/MyClaudeSetup) (`brew install bguidolim/tap/managed-claude-stack`)

## Design Influences

- [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) — Official Obsidian agent skills
- [James Bedford](https://x.com/jameesy) — Vault structure philosophy, separation of AI-generated content
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — Progressive disclosure via description fields, session hooks, kernel primitives

## License

MIT
