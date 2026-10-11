# Claude Code Hooks And Mod

This file applies only to Claude Code.

`.claude/settings.json` runs SessionStart, UserPromptSubmit, PostToolUse, PreCompact, and Stop scripts from `.claude/scripts/`. They inject session context, classify messages, validate Markdown writes, preserve transcripts before compaction, and report vault hygiene.

On supported Claude Code versions, the `obsidian-mind` mod in `.claude/skills/obsidian-mind/` delivers session context as an instruction file and presents Stop reports. It stands the duplicate settings hook down when active. Other agents run the shared scripts through their own configuration, so do not assume the mod exists outside Claude Code.
