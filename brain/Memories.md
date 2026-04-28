---
description: "Index of memory topics — key decisions, patterns, gotchas, people context"
tags:
  - brain
  - index
---

# Memories

Persistent context and knowledge retained across sessions.

- [[Key Decisions]] — all architectural and tooling decisions
- [[Patterns]] — Convex/Clerk/Expo code patterns and AI workflow patterns
- [[Gotchas]] — known traps (env vars, Windows App Control, Convex metadata overwrites)
- [[North Star]] — Anis's goals, Viblink focus, tech stack summary
- [[Skills]] — slash commands reference

## Current State (2026-04-28)

**Who**: Anis Rangrez, indie developer building Viblink social media app
**Codebase**: `d:\Viblink` — Expo + Expo Router + Convex + Clerk + NativeWind
**Memory vault**: `d:\Viblink\VibMind` (this vault, separate git repo)
**Agent**: Antigravity (Gemini-based)

**AI tooling fully set up:**
- `code-review-graph` → auto-updates on git commit, run from `d:\Viblink`
- `obsidian-mind` → this vault, manual updates when you tell the agent things
- `Superpowers` → 14 skills at `d:\Viblink\.agents\skills\`
- `Clerk skills` → 6 Expo-specific auth skills

**To start a memory session**: `cd d:\Viblink\VibMind` → open Antigravity → session-start hook fires automatically

**VibMind git is SEPARATE from Viblink git** — `VibMind/` is in Viblink's `.gitignore`
