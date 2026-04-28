---
description: "Things that have bitten before and will bite again — avoid these"
tags:
  - brain
  - gotchas
---

# Gotchas

Things that went wrong or caused confusion — so we don't repeat them.

## Expo / Clerk

- **`NEXT_PUBLIC_` prefix in Expo** — always use `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, never `NEXT_PUBLIC_`. The wrong prefix silently gives `undefined` in production builds.
- **No `tokenCache` on ClerkProvider** — tokens get lost on app restart. Always pass `tokenCache` from `@clerk/expo/token-cache`.
- **`useSSO` vs `useOAuth`** — `useSSO` replaced `useOAuth` in `@clerk/expo` v3+. Old code using `useOAuth` will fail.
- **OAuth scheme missing** — OAuth redirects silently fail if `"scheme"` is not set in `app.json`.

## code-review-graph

- **`uvx` not available** — package installed via pip, not uvx. Always use `python -m code_review_graph` not the `.exe` directly (blocked by Windows Application Control policy).
- **Small codebases** — graph overhead can exceed raw file size for single-file changes (normal behaviour, expected).

## Convex

- **Metadata overwrites** — `updateUser({ publicMetadata: { x: 1 } })` REPLACES all metadata, not merges. Always read → spread → write.
- **Convex HTTP URL** — webhook endpoint URL ends in `.convex.site`, NOT `.convex.cloud`.

## Git / Windows

- **Application Control policy** — Python `.exe` scripts in `AppData\Roaming\Python\...\Scripts` may be blocked. Use `python -m <module>` pattern instead.
