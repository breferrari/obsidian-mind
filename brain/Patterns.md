---
description: "Recurring patterns and conventions discovered across Viblink development"
tags:
  - brain
  - patterns
---

# Patterns

Recurring patterns and conventions used in the Viblink project.

## Code Patterns

### Convex Query Pattern
```typescript
// Always use indexes for performance — never scan full table
const user = await ctx.db
  .query("users")
  .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
  .first()
```

### Clerk Hook Pattern (Expo)
```typescript
// Always check isLoaded before using any Clerk hook result
const { isLoaded, isSignedIn, userId } = useAuth()
if (!isLoaded) return <ActivityIndicator />
if (!isSignedIn) return <Redirect href="/sign-in" />
```

### Expo Router Protected Group
```
app/
  (auth)/          ← protected — checks isSignedIn in _layout.tsx
    _layout.tsx    ← redirect to /sign-in if not authenticated
    profile.tsx
  (public)/        ← open routes
    sign-in.tsx
    sign-up.tsx
```

## AI Workflow Patterns

### Superpowers Flow
```
New feature request
  → brainstorming skill (design + spec first)
  → writing-plans skill (bite-sized TDD tasks)
  → subagent-driven-development (fresh agent per task + 2-stage review)
  → finishing-a-development-branch (merge/PR)
```

### code-review-graph Usage
- Run `python -m code_review_graph update` after large uncommitted changes
- Graph auto-updates on `git commit` via pre-commit hook
- Use MCP tools `semantic_search_nodes`, `detect_changes`, `get_impact_radius` instead of grep

### obsidian-mind Session Pattern
```
Start session in VibMind dir → agent reads North Star + Memories
Work on Viblink (in d:\Viblink) → reference vault for context
End session → agent updates Key Decisions / Gotchas if needed
```
