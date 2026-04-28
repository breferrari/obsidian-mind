---
date: 2026-04-28
description: "Viblink codebase architecture reference — file structure, key modules, entry points"
tags:
  - reference
  - viblink
  - architecture
---

# Viblink Codebase Reference

Quick architecture reference for the Viblink Expo app at `d:\Viblink`.

## Key Paths

| Path | Purpose |
|------|---------|
| `d:\Viblink` | Main codebase root |
| `d:\Viblink\.agents\skills\` | AI agent skills (Superpowers + Clerk) |
| `d:\Viblink\.mcp.json` | MCP server config (code-review-graph) |
| `d:\Viblink\GEMINI.md` | Antigravity operating instructions |
| `d:\Viblink\AGENTS.md` | Multi-agent operating instructions |
| `d:\Viblink\.code-review-graph/` | Graph database (auto-managed, gitignored) |
| `d:\Viblink\VibMind\` | This obsidian-mind memory vault |

## AI Tools Running in This Project

### code-review-graph (MCP)
- **What**: Structural code map of Viblink's TS/TSX files
- **Update**: `python -m code_review_graph update` (or auto on git commit)
- **Stats** (as of 2026-04-28): 25 nodes, 102 edges, 16 files
- **MCP config**: `d:\Viblink\.mcp.json`

### obsidian-mind (this vault)
- **What**: Persistent memory across coding sessions
- **Vault**: `d:\Viblink\VibMind\`
- **Start a session**: `cd d:\Viblink\VibMind` then run Antigravity
- **Hooks**: SessionStart auto-injects North Star + active projects + recent changes

### Superpowers Skills
- **Location**: `d:\Viblink\.agents\skills\`
- **14 skills** covering: brainstorming, planning, TDD, debugging, code review, git worktrees

### Clerk Skills (Expo-Specific)
- **Location**: `d:\Viblink\.agents\skills\clerk\`
- **6 skills** all optimized for Expo + Convex (web framework content removed)

## Tech Stack Summary

```
Expo (Expo Router v4)
  └── React Native (TypeScript)
       ├── NativeWind (Tailwind for RN)
       ├── Clerk (@clerk/expo v3+) — auth
       └── Convex — real-time backend + database
```

## Running the Dev Server

```bash
cd d:\Viblink
npx expo start
```

## Key Environment Variables

```env
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...   # ← EXPO_PUBLIC_ prefix required
EXPO_PUBLIC_CONVEX_URL=https://...convex.cloud
CLERK_SECRET_KEY=sk_test_...                     # server-side only, never in client
```

## Related

- [[Viblink]] — active project note with status and todos
- [[Key Decisions]] — architectural decisions
- [[Gotchas]] — known issues and pitfalls
