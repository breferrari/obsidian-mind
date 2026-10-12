Shared section: Claude Code and Grok load it at session start; other agents read it when AGENTS.md points here.

## Session Workflow

### Starting a Substantial Session

The `SessionStart` hook automatically injects rich context: vault file listing, North Star goals, active work, recent git changes, open tasks (aggregated from `work/active/` and the vault root, excluding infrastructure files), vault-hygiene drift flags (act on them or run `/om-tidy`), and triggers a QMD re-index. Most context is already loaded -- you don't need to manually read files.

**Shortcut**: Run `/om-standup` for a structured morning kickoff that reads everything and presents a summary with suggested priorities.

If doing it manually:

1. Read `Home.md` -- vault entry point with embedded dashboards
2. Read `brain/North Star.md` -- ground suggestions in current goals
3. Check `work/Index.md` -- see active projects and recent notes
4. Scan `brain/Memories.md` -- index of memory topics, then read relevant topic notes
5. `obsidian tasks daily todo` -- see pending items

### Ending a Substantial Session

If `/om-wrap-up` is not invoked, at minimum do these before wrapping up:

1. **Archive completed projects**: `git mv` from `work/active/` to `work/archive/YYYY/`, update `status: completed` (or use `/om-project-archive`)
2. Update `work/Index.md` if new notes or decisions were created
3. Update the relevant brain topic note (`brain/Key Decisions.md`, `brain/Patterns.md`, `brain/Gotchas.md`) with key learnings
4. Update `org/People & Context.md` if org knowledge changed
5. Update `perf/Brag Doc.md` if wins or impact were achieved
6. Offer to update `brain/North Star.md` if goals shifted or new focus emerged
7. Verify all new notes link to at least one existing note (orphans are bugs)
8. If work demonstrates competencies, add competency links to the work note's `## Related`
9. Run `/om-vault-audit` if the session created many notes

Skip steps that don't apply. The goal is transferring durable knowledge from conversation to vault state.
