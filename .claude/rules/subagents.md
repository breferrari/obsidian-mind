# Claude Code Subagents

This file applies only to Claude Code. Specialized prompts live in `.claude/agents/` and run in isolated context windows.

| Agent | Purpose |
| --- | --- |
| `brag-spotter` | Finds uncaptured wins and competency gaps. |
| `context-loader` | Loads vault context about a person, project, or concept. |
| `correction-sweep` | Finds restatements of a corrected fact; never edits. |
| `cross-linker` | Finds missing links, orphans, and broken backlinks. |
| `people-profiler` | Bulk creates or updates person notes. |
| `review-prep` | Aggregates evidence for a review period. |
| `slack-archaeologist` | Reconstructs Slack context. |
| `vault-librarian` | Performs deep vault maintenance. |
| `review-fact-checker` | Verifies review claims against sources. |
| `vault-migrator` | Classifies and migrates another vault. |
