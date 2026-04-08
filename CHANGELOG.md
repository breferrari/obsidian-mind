# Changelog

## v3.6 — 2026-04-07

### Added
- `/prep-1on1` command — prep for an upcoming 1:1 by loading person context, recent history, active work, wins to share, and a suggested agenda. Run before the meeting; use `/capture-1on1` after.

### Changed
- CLAUDE.md: added `/prep-1on1` to command table (15→16 commands)
- README: added `/prep-1on1` to commands table and vault structure diagram (15→16 commands)
- `brain/Skills.md`: renamed "Capture & Documentation" category to "Meeting Prep & Capture", added `/prep-1on1`

## v3.5 — 2026-04-05

### Added
- Demo GIF (`obsidian-mind-demo.gif`) showing `/standup` and `/dump` in action — embedded in all four READMEs

### Changed
- README: restructured section order — Quick Start and Requirements moved up (from sections 12–13 to 4–5), Upgrading moved down (from section 11 to 16). No content added or removed.
- All translated READMEs (ja, zh-CN, ko) updated with same structure and demo GIF

## v3.4.1 — 2026-04-05

### Fixed
- `classify-message.py`: hook output missing required `hookEventName` field — caused Claude Code to show "hook error" on every prompt
- `validate-write.py`: same missing `hookEventName` field in PostToolUse output
- Both scripts: added `OSError` to stdin exception handling, wrapped `main()` in top-level `try/except` for resilience
- `settings.json`: bumped classify-message timeout 10s → 15s

## v3.4 — 2026-04-05

### Added
- `classify-message.py`: native CJK classification patterns (Japanese, Korean, Simplified Chinese) for all 7 signal categories — pure CJK messages now trigger routing hints
- `classify-message.py`: English inflection coverage — all common verb forms (`-ing`, `-s`/`-es`) for delivery words now detected
- `.claude/scripts/test_hooks.py`: unittest suite for `classify-message.py` and `validate-write.py` — covers English, CJK, inflections, overlaps, false positives, type safety, integration

## v3.3.1 — 2026-04-05

### Fixed
- `classify-message.py`: crash (rc=1) when `prompt` is non-string type (int, None, bool, list) — now validates type before processing
- `classify-message.py`: `\b` word boundaries failed with CJK text — `\bdecision\b` did not match in `のdecisionについて` because Python treats CJK characters as `\w`. Replaced with Latin-letter lookaround `(?<![a-zA-Z])` / `(?![a-zA-Z])`
- `classify-message.py`: missing detection patterns — added `1-1`, `praised`, `win`, `mentioned the`, `mentioned a` to classifiers
- `classify-message.py`: delivery words (`shipped`, `launched`, `released`, `deployed`, `completed`) now trigger both WIN and PROJECT UPDATE (categories were incorrectly mutually exclusive)
- `classify-message.py`: added new PROJECT UPDATE patterns — `went live`, `rolled out`, `merged`, `cut the release`
- `classify-message.py`: changed `list[str]` return annotation to `list` for Python 3.8 compatibility
- `validate-write.py`: crash (rc=1) when `tool_input` is null or `file_path` is non-string — now validates types before processing
- `validate-write.py`: translated READMEs (README.ja.md, README.zh-CN.md, etc.) were validated as vault notes — now skipped
- `settings.json`: removed `MultiEdit` from PostToolUse matcher (not a valid Claude Code tool name)
- `settings.json`: removed unsupported `matcher` field from Stop hook (Stop event does not support matchers)
- `settings.json`: added `compact` to SessionStart matcher (hook was not firing after context compaction)
- `settings.json`: added `stop_hook_active` re-entry guard to Stop hook (prevents infinite loop when Claude acts on checklist output)

### Changed
- `classify-message.py`: refactored from 7 hardcoded if-blocks to data-driven `SIGNALS` list — patterns are now declarative, overlaps between categories are explicit and visible

## v3.3 — 2026-03-29

### Added
- `/vault-upgrade` command — import and migrate content from an existing Obsidian vault (any version of obsidian-mind or arbitrary vaults). Detects source version via fingerprints, classifies notes, transforms frontmatter, fixes wikilinks, rebuilds indexes. Supports `--dry-run`.
- `vault-migrator` subagent — classifies files (tiered heuristics: structural → frontmatter → content → fallback) and executes approved migration plans. Two modes: classification and execution.
- `vault-manifest.json` — declares template version, infrastructure vs user content boundaries, frontmatter schemas, version fingerprints, and field aliases. Enables version detection and targeted migrations.

### Changed
- CLAUDE.md: added `/vault-upgrade` command and `vault-migrator` agent, updated counts (14→15 commands, 8→9 agents)
- README: added "Upgrading" section explaining the migration workflow
- `brain/Skills.md`: added `/vault-upgrade` to Maintenance category and `vault-migrator` to subagents table

## v3.2.1 — 2026-03-29

### Fixed
- `find-python.sh`: detect Windows via `uname -s` and skip `python3` entirely (Windows Store stub is unreliable — can hang, consume stdin, or cause hook timeouts)
- `find-python.sh`: use `command -v` instead of `python3 --version` on macOS/Linux (faster, no side effects)
- `classify-message.py`: replace substring matching (`in`) with word-boundary regex (`\b`) — fixes false positives where "markdown", "wonder", "download", etc. triggered signals
- `classify-message.py`: add `sys.stdout.flush()` before exit to prevent buffered output loss on Windows
- `validate-write.py`: remove unused `import re` and dead `body` variable, add `sys.stdout.flush()` before exit
- `pre-compact.sh`: use `find-python.sh` instead of hardcoded `python3` (was bypassing the cross-platform resolver), merge two Python calls into one
- `session-start.sh`: quote `$CLAUDE_PROJECT_DIR` in exported value (paths with spaces broke the export)
- `session-start.sh`: exclude `.git/` from vault file listing (consistent with other exclusions)
- `charcount.sh`: use `${1:-}`, `${2:-}`, `${3:-}` for positional args (with `set -u`, missing args crashed before reaching the friendly usage message)

## v3.2 — 2026-03-29

### Added
- `/humanize` command — voice-calibrated editing that matches your writing style, not a generic AI word blacklist
- `/weekly` command — cross-session weekly synthesis with North Star alignment, pattern detection, and uncaptured win spotting

### Fixed
- `validate-write.py`: normalized path separators for Windows (backslashes weren't matching forward-slash skip list)
- `validate-write.py`: added `thinking/` to skip list (scratchpad notes shouldn't trigger validation warnings)

### Changed
- CLAUDE.md: reordered command table by category, added new commands, fixed stale counts (10→14 commands, 7→8 agents), added `review-fact-checker` subagent
- README: updated command table, daily workflow section, command and agent counts
- `brain/Skills.md`: added Editing & Synthesis category, new commands, usage notes, and Weekly Review workflow

## v3.1 — 2026-03-27

### Added
- Vault-first memory system — all project memories live in `brain/` (git-tracked), `MEMORY.md` becomes an index-only pointer
- `/self-review` command — guided self-assessment workflow with strategic calibration, fact-checking, and character limit validation
- `/review-peer` command — peer review writer with visibility classification, tone rules, and quality checks
- `review-fact-checker` subagent — verifies every claim in a review draft against vault sources
- `charcount.sh` utility script — counts characters in markdown sections for review tools with character limits
- `.claude/memory-template.md` — template users copy to `~/.claude/` to wire up vault-first memory

### Changed
- CLAUDE.md: "Two Memory Systems" replaced with "Memory System" (vault-first rule, setup instructions)
- CLAUDE.md: Rules section updated to enforce vault-first memory (never create files in `~/.claude/`)
- README: updated memory description, command/agent counts, added new commands and subagent
- `brain/Skills.md`: added new commands, subagent, and updated review cycle workflow

## v3 — 2026-03-26

### Added
- `/standup` command — morning kickoff that loads context and suggests priorities
- `/dump` command — freeform capture that auto-classifies and routes to the right notes
- 7 subagents: `brag-spotter`, `context-loader`, `cross-linker`, `people-profiler`, `review-prep`, `slack-archaeologist`, `vault-librarian`
- 5 lifecycle hooks: SessionStart (rich context injection), UserPromptSubmit (message classification), PostToolUse (write validation), PreCompact (transcript backup), Stop (session end checklist)
- QMD semantic search integration (optional) with custom skill in `.claude/skills/qmd/`
- Hook scripts in `.claude/scripts/`: `session-start.sh`, `classify-message.py`, `validate-write.py`, `pre-compact.sh`
- `thinking/session-logs/` for transcript backups before context compaction

### Changed
- README rewritten as product documentation with badges, scenarios, daily workflow, and performance graph sections
- CLAUDE.md updated with subagents table, hooks table, QMD skill reference, `/standup` shortcut in session workflow
- `brain/Skills.md` reorganized by category (Daily, Capture, Performance, Maintenance) with subagents and hooks tables

## v2 — 2026-03-26

### Added
- `Home.md` — vault dashboard with embedded Base views
- `bases/` — 7 centralized Obsidian Bases (Work Dashboard, Incidents, People Directory, 1-1 History, Review Evidence, Competency Map, Templates)
- `work/active/` + `work/archive/YYYY/` — explicit project lifecycle
- `work/incidents/` — structured incident tracking
- `work/1-1/` — 1:1 meeting notes
- `org/` — organizational knowledge (`org/people/`, `org/teams/`, `People & Context.md`)
- `reference/` — codebase knowledge and architecture docs
- `perf/evidence/` — PR deep scans for review prep
- `perf/brag/` — quarterly brag notes
- 8 slash commands: `/peer-scan`, `/slack-scan`, `/capture-1on1`, `/vault-audit`, `/review-brief`, `/incident-capture`, `/project-archive`, `/wrap-up`
- `.claude/update-skills.sh` for syncing obsidian-skills from upstream

### Changed
- Renamed `claude/` → `brain/` with split files (Memories index, Key Decisions, Patterns, Gotchas, Skills, North Star)
- Moved `perf/Review Template.md` → `templates/Review Template.md`
- CLAUDE.md rewritten with comprehensive session workflow, note types, linking conventions, Bases documentation, properties for querying, agent guidelines
- `perf/Brag Doc.md` updated to quarterly sub-note structure

### Removed
- `claude/Memories.md` monolith (replaced by split brain/ files)

## v1 — 2026-03-01

Initial release. Basic vault structure with:
- `claude/` — Memories, North Star, Skills (monolithic)
- `work/` — flat work notes with Index.md
- `perf/` — Brag Doc, Review Template, competencies/
- `templates/` — Work Note, Decision Record, Thinking Note, Competency Note
- `thinking/` — scratchpad
- SessionStart hook (file listing injection)
- [obsidian-skills](https://github.com/kepano/obsidian-skills) pre-installed
