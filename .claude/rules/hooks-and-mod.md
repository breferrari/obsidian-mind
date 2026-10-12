# Hooks and the obsidian-mind Mod (Claude Code)

Claude Code loads this file beside `AGENTS.md`, which holds every convention the other agents share.

| Folder | Purpose | Key Files |
|--------|---------|-----------|
| `.claude/scripts/` | Hook scripts + the MCP server | `session-start.ts`, `classify-message.ts`, `validate-write.ts`, `pre-compact.ts`, `stop-checklist.ts`, `charcount.ts`, `om-mcp.mjs` (see **Reaching the Vault From Another Repo** in `ARCHITECTURE.md`) |

## Hooks

The lifecycle hooks in `.claude/settings.json`:

| Hook | When | What |
|------|------|------|
| SessionStart | On startup/resume | QMD re-index + self-heal, inject North Star, active work, recent changes, tasks, file listing (folders past a note-count threshold collapse to one line), vault-hygiene drift flags (completed-not-archived, ungrouped clusters, 25KB oversize, stale open loops, meetings-inbox pressure); the whole injection is held under a byte budget that fits Claude Code's 10,000-character hook output cap — over it, low-priority sections degrade to pointers and the closing injection-size meter names each one it dropped |
| UserPromptSubmit | Every message | Classifies content (decision, incident, win, 1:1, architecture, person, project update) and injects routing hints; also hands the agent a Stop report saved since the last prompt |
| PostToolUse | After writing `.md` | Validates frontmatter + wikilinks, blocks misplaced memory files, flags notes crossing the 25KB organization threshold (split, don't trim) and write-time topic clusters |
| PreCompact | Before context compaction | Backs up session transcript to `thinking/session-logs/` |
| Stop | After every response | Checklist + concrete vault-hygiene drift findings (same scan as SessionStart), shown once per session and again only when the findings change; hands drift to `om-tidy`. A Stop `systemMessage` reaches only the user, and every Stop output that reaches the agent is also printed in full for the user. So a changed report shows the user a one-line-per-section summary and saves the full report for the next prompt, where the UserPromptSubmit hook hands it to the agent unseen; the agent deals with the user's message first, then acts, asks, or leaves it. If the report cannot be saved, it goes out as Stop feedback instead. SessionEnd and a Stop without a session id show the full report. Also triggers the debounced QMD refresh. For thorough review, use `/om-wrap-up` instead. |

**On Claude Code 2.1.287+, the `obsidian-mind` mod** (`.claude/skills/obsidian-mind/`) delivers the SessionStart context as an instruction file instead: it runs `session-start.ts` itself and passes the settings hook `om_mod: "standdown"` for that event. The context then survives compaction whole and reaches general-purpose subagents (Explore and Plan skip instruction files by design); `/memory` shows it as `.claude/session-context.md`. It also presents the Stop report: it runs `stop-checklist.ts` with `om_mod: "report"`, stands the Stop hook down, draws one line under the answer when the findings changed, and hands you the full report with the user's next prompt (typed, over Remote Control, through the SDK or a Slack ping; a peer message, a notification or a scheduled prompt does not consume it), or with the mod's own prompt for an urgent finding, at most one per prompt the user sends. Wherever the mod does not load (Codex, Gemini, older Claude Code, an untrusted folder, a session started in a vault subfolder), the hooks above run unchanged.

