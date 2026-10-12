---
description: "Morning kickoff. Load today's context, review yesterday, surface open tasks, and identify priorities."
---

Run the morning standup.

**Start from the SessionStart injection — do NOT re-read what it already carries.** The hook has already injected: the North Star excerpt, active work, recent git changes, open tasks, hygiene flags (incl. open loops), and the file listing. Re-reading `Home.md`, `brain/North Star.md`, or re-running `git log` doubles the token cost for zero new information.

Gather only what the injection does NOT have:

1. Read yesterday's and today's daily notes if they exist: `obsidian daily:read`
2. List Obsidian-tracked tasks: `obsidian tasks daily todo` (the injected Open Tasks section covers checkbox tasks in active notes and the vault root — this adds daily-note tasks)
3. Read `work/Index.md` ONLY if the injected active-work list needs status detail the summary will actually use
4. Check for unprocessed inbox items (`work/meetings/` raw exports — the hygiene flags name them when they age)

Present a structured standup summary:
- **Yesterday**: What got done (from the injected Recent Changes + daily note)
- **Active Work**: Current projects in work/active/ with their status
- **Open Tasks**: Pending items
- **Open Loops**: stale follow-ups from the injected hygiene flags — anything to chase today?
- **North Star Alignment**: How active work maps to current goals
- **Suggested Focus**: What to prioritize today based on goals + open items — act on injected hygiene flags here

Keep it concise. This is a quick orientation, not a deep dive.

## Starting a Substantial Session

The `SessionStart` hook automatically injects rich context: vault file listing, North Star goals, active work, recent git changes, open tasks (aggregated from `work/active/` and the vault root, excluding infrastructure files), vault-hygiene drift flags (act on them or run `/om-tidy`), and triggers a QMD re-index. Most context is already loaded -- you don't need to manually read files.

**Shortcut**: Run `/om-standup` for a structured morning kickoff that reads everything and presents a summary with suggested priorities.

If doing it manually:

1. Read `Home.md` -- vault entry point with embedded dashboards
2. Read `brain/North Star.md` -- ground suggestions in current goals
3. Check `work/Index.md` -- see active projects and recent notes
4. Scan `brain/Memories.md` -- index of memory topics, then read relevant topic notes
5. `obsidian tasks daily todo` -- see pending items
