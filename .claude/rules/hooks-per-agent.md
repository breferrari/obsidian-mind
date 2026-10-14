Shared section: Claude Code and Grok load it at session start; other agents read it when AGENTS.md points here.

## Hooks

The hook scripts in `.claude/scripts/` are agent-agnostic TypeScript and shell, executed natively by Node via `--experimental-strip-types` — no build step, no runtime dependencies, no Claude SDK. Hook configs are provided for these agents:

| Agent | Config | Status |
|-------|--------|--------|
| Claude Code | `.claude/settings.json` | Full support |
| Codex CLI | `.codex/hooks.json` | Shared hook scripts |
| Gemini CLI | `.gemini/settings.json` | Shared hook scripts |

| Script | Purpose | Claude event | Codex event | Gemini event |
|--------|---------|--------------|-------------|--------------|
| `session-start.ts` | Inject vault context at startup | SessionStart | SessionStart | SessionStart |
| `classify-message.ts` | Classify messages, inject routing hints, hand over the last Stop report (Claude Code and Codex: Gemini's checklist runs on SessionEnd and saves none); under Gemini, re-inject the session context on the first prompt after a compression | UserPromptSubmit | UserPromptSubmit | BeforeAgent |
| `validate-write.ts` | Validate frontmatter and wikilinks | PostToolUse | PostToolUse | AfterTool |
| `pre-compact.ts` | Back up transcript before compaction; under Gemini, which fires no SessionStart after compressing, also store the session context for re-injection (#357) | PreCompact | — | PreCompress |
| `stop-checklist.ts` | Wrap-up checklist and vault-hygiene drift findings (Claude Code and Codex: per response, deduped; Gemini: once, at shutdown) | Stop | Stop | SessionEnd |

Codex runs these hooks only once the vault folder is trusted and each hook approved (observed with Codex CLI 0.160.0 as of 2026-10-13, #345; the setup is in README's "Using with Other Agents").

Grok, once the vault is trusted, loads the project `.claude/settings.json` hooks (observed for #321); how each event behaves under Grok is not verified (TBC), and its own layer is #323.
