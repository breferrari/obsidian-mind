---
description: "Index of memory topics — key decisions, patterns, gotchas, people context"
tags:
  - brain
  - index
---

# Memories

Persistent context and knowledge retained across sessions. Each topic lives in its own note — follow the links.

- [[Key Decisions]] — architectural and workflow decisions worth recalling
- [[Patterns]] — recurring patterns and conventions discovered across work
- [[Gotchas]] — things that have bitten before and will bite again
- [[People & Context]] — org structure, teams, review history, dynamics
- [[North Star]] — living goals document, read at session start
- [[Skills]] — custom slash commands and workflows

## Recent Context

-

## When to Consult Brain Topics

The SessionStart hook injects a **Brain Topics (read on demand)** index listing each `brain/` topic note with its description and an `(empty)` marker for stub notes. Treat that index as a menu:

- When the user's message touches a topic from the index (debugging → Gotchas, "how do we usually…" → Patterns, "why did we decide" → Key Decisions, "which command / slash" → Skills), query QMD **first** before answering — call `mcp__qmd__query` with a `query` argument describing the topic (or fall back to `qmd --index <name> query "<topic>"` if MCP is unavailable). The search covers the whole vault, so filter or prioritize results whose `file` path is under `brain/`. Do not assume the topic name alone scopes the search.
- If QMD is unavailable, read the specific `brain/` note directly with the Read tool. Don't load all of `brain/` — only the one(s) matching the topic.
- Skip notes marked `(empty)` in the index — they're stubs with no substantive content.
- After answering, if the conversation produced durable knowledge, update the relevant brain note (see the "remember" workflow in `AGENTS.md` → **Memory System**).
