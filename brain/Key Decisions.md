---
date: 2026-04-28
description: "Architectural and workflow decisions worth recalling across sessions — each links to its source work note"
tags:
  - brain
---

# Key Decisions

## 2026-04-28 — Viblink Stack Locked

- **Convex** as backend — real-time reactive queries, serverless, no custom server
- **Clerk** (`@clerk/expo` v3+) for auth — SecureStore token cache, OAuth via `useSSO`
- **Expo Router** for navigation — file-based routing, protected route groups
- **NativeWind** for styling — Tailwind in React Native
- **Antigravity** (Gemini-based) as AI coding agent

## 2026-04-28 — AI Tooling Stack Finalized

### code-review-graph (Token Efficiency)
- Installed via: `pip install code-review-graph`
- Run command: `python -m code_review_graph` (NOT the `.exe` — blocked by Windows App Control)
- Configured for: **Antigravity + Claude Code only** (Cursor, Kiro, Windsurf, OpenCode configs deleted)
- MCP config: `d:\Viblink\.mcp.json` → uses `python -m code_review_graph serve`
- Antigravity MCP: `C:\Users\anisa\.gemini\antigravity\mcp_config.json`
- Auto-updates: **YES** — git pre-commit hook updates graph on every commit
- Manual update: `python -m code_review_graph update` (run from `d:\Viblink`)
- Stats (2026-04-28): 25 nodes, 102 edges, 16 files tracked

### obsidian-mind (Persistent Memory)
- Vault location: `d:\Viblink\VibMind\`
- **Kept SEPARATE from Viblink git** — added `VibMind/` to `d:\Viblink\.gitignore`
- VibMind has its **own git history** (was cloned from obsidian-mind repo)
- Obsidian app: installed for browsing notes visually (NOT required for functionality)
- Hooks: Gemini CLI hooks in `.gemini/settings.json` — session-start auto-injects North Star + context
- Auto-updates: **NO** — you tell the agent things → agent writes to notes → next session reads them
- QMD semantic search: NOT installed (optional, needs ~1.6GB model download)

### Superpowers Skills (Development Workflow)
- Location: `d:\Viblink\.agents\skills\`
- 14 skills: brainstorming → writing-plans → TDD → debugging → review → git worktrees
- Hard-gate: design approval + plan before any code

### Clerk Skills (Expo-Specific)
- Location: `d:\Viblink\.agents\skills\clerk\`
- 6 skills, ALL rewritten for Expo + Convex
- Removed: Next.js, Vue, Nuxt, Astro, Chrome Extension, Swift, Android, Playwright/Cypress

## 2026-04-28 — File Cleanup Decisions

**Deleted from VibMind (obsidian-mind clutter):**
- README.md (all 4 language versions) — marketing, not useful in vault
- ARCHITECTURE.md, CHANGELOG.md, CONTRIBUTING.md — template developer docs
- obsidian-mind-demo.gif (4.2MB), obsidian-mind-logo.png (540KB) — pure waste
- `.codex/`, `.claude-plugin/`, `.shardmind/`, `.github/` — other platform configs
- `.claude/scripts/tests/` (26 test files) — obsidian-mind developer tests, not yours
- `vault-manifest.json`, `.shardmindignore`, `.mcp.json` — template meta files

**Deleted from Viblink (code-review-graph clutter):**
- `.cursor/`, `.cursorrules` — Cursor IDE config
- `.kiro/`, `.windsurfrules` — Kiro/Windsurf configs
- `.opencode.json` — OpenCode config
