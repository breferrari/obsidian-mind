# Auto-Memory Index (Claude Code)

Claude Code loads this file beside `AGENTS.md`, which holds every convention the other agents share.

**All project memories live in the vault.** The `~/.claude/` MEMORY.md is an auto-loaded index that points to vault locations. The `~/.claude/` MEMORY.md is the only file that should exist there -- it is an auto-loaded index. Never create additional memory files in that directory.

| System | Location | Purpose |
|--------|----------|---------|
| **MEMORY.md** | `~/.claude/projects/.../memory/MEMORY.md` | Auto-loaded index only. Pointers to vault notes. |

When asked to "remember" something (steps 1–3 are in `AGENTS.md` → **Memory System**):

4. Do NOT create additional files in `~/.claude/projects/.../memory/` beyond MEMORY.md -- they are not version-controlled
