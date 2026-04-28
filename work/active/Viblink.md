---
date: 2026-04-28
description: "Viblink social media app — main active project"
project: Viblink
status: active
quarter: Q2-2026
tags:
  - work
  - active
  - expo
  - convex
  - clerk
---

# Viblink

Social media app built with Expo + Convex + Clerk. Currently in active development toward MVP.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Expo (Expo Router) |
| Language | TypeScript |
| UI | React Native + NativeWind |
| Backend/DB | Convex |
| Auth | Clerk (`@clerk/expo` v3+) |
| Agent | Antigravity (Gemini-based AI coding assistant) |

## Repo

Path: `d:\Viblink`
Branch: `main`

## AI Development Setup

| Tool | Purpose |
|------|---------|
| code-review-graph | Structural code map — reduces token waste during AI coding |
| obsidian-mind | Persistent agent memory across sessions (this vault) |
| Superpowers skills | Structured workflow: brainstorming → plans → TDD → review |
| Clerk skills | 5 Expo-focused auth skills in `.agents/skills/clerk/` |

## Superpowers Skills Installed

Located at: `d:\Viblink\.agents\skills\`

- `brainstorming` — design-first before coding
- `writing-plans` — bite-sized TDD implementation plans
- `test-driven-development` — red-green-refactor enforcement
- `systematic-debugging` — root cause before fixing
- `verification-before-completion` — evidence before claims
- `subagent-driven-development` — fresh subagent per task with review
- `executing-plans` — in-session plan execution
- `requesting-code-review` / `receiving-code-review` — code review workflow
- `dispatching-parallel-agents` — parallel agents for independent tasks
- `using-git-worktrees` — isolated workspaces
- `finishing-a-development-branch` — merge/PR/discard options
- `using-superpowers` — meta-skill router
- `writing-skills` — TDD for creating new skills

## Clerk Auth Skills (Expo-Specific)

Located at: `d:\Viblink\.agents\skills\clerk\`

All rewritten for Expo + Convex (web framework references removed):
- `clerk` — router skill
- `clerk-setup` — install + Convex JWT template
- `clerk-expo-patterns` — OAuth, SecureStore, protected routes
- `clerk-custom-ui` — custom sign-in/up with hooks (RN)
- `clerk-backend-api` — REST API for user management
- `clerk-webhooks` — Convex HTTP action handler for user sync

## Current Status

- [ ] Core Viblink features (posts, follows, profiles)
- [ ] Convex schema finalized
- [ ] Clerk auth flow complete
- [ ] Ship to TestFlight internal testing

## Related

- [[North Star]] — goals and direction
- [[Key Decisions]] — architectural decisions
