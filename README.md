# Obsidian Mind

An Obsidian vault template designed for engineers who use Claude Code as a thinking partner. Your external brain for work notes, decisions, performance tracking, and persistent AI context.

## What This Is

A ready-to-use vault structure that makes Claude Code productive from session one. Every conversation builds on the last because Claude has persistent context in the vault — your goals, your decisions, your patterns, your wins.

## Quick Start

1. Clone this repo (or use it as a template)
2. Open the folder as an Obsidian vault
3. Enable the Obsidian CLI in Settings > Core plugins (requires Obsidian 1.12+)
4. Install the [obsidian-git](https://github.com/denolehov/obsidian-git) community plugin for sync
5. Run `claude` in the vault directory
6. Fill in `claude/North Star.md` with your goals — this grounds every session

## Vault Structure

```
work/           Work notes, project tracking, decision records
perf/           Brag doc, performance review templates
claude/         Claude context: memories, skills, goals (North Star)
thinking/       Claude's scratchpad for drafts and reasoning
templates/      Obsidian templates with YAML frontmatter
```

### Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Operating manual for Claude — loaded automatically every session |
| `claude/North Star.md` | Your goals and focus areas — grounds Claude's suggestions |
| `claude/Memories.md` | Persistent knowledge Claude retains across sessions |
| `claude/Skills.md` | Custom workflows and reusable prompts |
| `work/Index.md` | Map of Content — central hub for all work notes |
| `perf/Brag Doc.md` | Running log of wins, linked to evidence |

## What's Included

### Obsidian Skills

[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) pre-installed in `.claude/skills/`:

- **obsidian-markdown** — Teaches Claude Obsidian-flavored markdown (wikilinks, embeds, callouts, properties)
- **obsidian-cli** — CLI commands for vault operations
- **json-canvas** — Visual canvas file creation
- **obsidian-bases** — Database-style base files
- **defuddle** — Web page to markdown extraction

### SessionStart Hook

A hook in `.claude/settings.json` injects the vault file listing into every Claude session. Claude immediately knows what exists — no wasted turns on discovery.

### Templates

Three templates with YAML frontmatter including a `description` field for progressive disclosure:

- **Work Note** — date, description, project, status, tags
- **Decision Record** — date, description, status (proposed/accepted/deprecated), tags
- **Thinking Note** — date, description, context, tags

### Session Workflow

CLAUDE.md defines start and end workflows:

- **Start**: Read North Star, check Index, scan Memories
- **End**: Update indexes, capture learnings, log wins

## How It Works

The vault is built around **wikilinks**. Every note links to related notes, building a graph that compounds over time:

- Work notes link to decisions that came from them
- The brag doc links to work notes as evidence
- Memories link to where they were learned
- The thinking folder links drafts to their final notes

Claude maintains the indexes (`work/Index.md`, `claude/Memories.md`, `perf/Brag Doc.md`) as notes are created, so the graph stays navigable.

## Customization

This is a starting point, not a straitjacket. Adapt it to how you work:

- Add folders for your domain (e.g., `meetings/`, `1on1s/`, `research/`)
- Create new templates in `templates/`
- Add custom skills in `claude/Skills.md`
- Extend the CLAUDE.md with your own conventions

## Requirements

- [Obsidian](https://obsidian.md) 1.12+ (for CLI support)
- [Claude Code](https://claude.ai/claude-code)
- Git (for version history and sync)

## Design Influences

- [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) — Official Obsidian agent skills
- [James Bedford](https://x.com/jameesy) — Vault structure philosophy, separation of AI-generated content
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — Progressive disclosure via description fields, session hooks, kernel primitives

## License

MIT
