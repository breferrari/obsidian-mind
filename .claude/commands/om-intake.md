---
description: "Process all unread meeting notes in work/meetings/ — reads each file, classifies content, routes to the right vault notes, then clears the inbox."
---

# Meeting Intake

Scans `work/meetings/` for unprocessed meeting exports and routes everything to the correct vault locations automatically. No arguments needed — just drop files and run.

## Usage

```
/om-intake
```

Drop any exported or raw meeting note into `work/meetings/` first. Run this command after. Naming convention: `YYYY-MM-DD <Topic or Person>.md`.

## Workflow

### 1. Scan the Inbox

List all `.md` files in `work/meetings/` excluding `README.md`. If the folder is empty, say so and stop.

For each file found, read the full content before doing anything else.

### 2. Identify Meeting Type

For each note, determine what kind of meeting it was:

- **1:1** — between two people; personal, career, feedback, or relationship content
- **Project meeting** — status update, check-in, or planning session tied to a specific project
- **Team meeting** — standup, sprint planning, retrospective, or all-hands
- **Decision meeting** — primary purpose was to reach a decision
- **Mixed** — multiple types in one note (process each piece separately)

Use the note's content, title, and any attendee list to make this call.

### 3. Search for Related Vault Context

Before routing, run `qmd query "<meeting topic or person name>"` to find existing notes the content should attach to. Prefer appending to existing notes over creating new ones for small updates.

### 4. Route Content

Apply these routing rules to each piece of content:

| Content Type | Destination |
|---|---|
| 1:1 with a specific person | Create `work/1-1/<Person> YYYY-MM-DD.md` using 1:1 note structure |
| Project status update | Append to relevant `work/active/<Project>.md` |
| New project or initiative not in vault | Create `work/active/<Project>.md` |
| Decision reached | Create Decision Record in `work/` + add to Decisions Log in `work/Index.md` |
| Action item / open task | Append as `- [ ]` to the relevant work note |
| Win or recognition | Add to `perf/Brag Doc.md` with link to source note |
| New person mentioned not in vault | Create stub in `org/people/<Name>.md` |
| Blocker identified | Append to relevant `work/active/` note under `## Blockers` or `## Open / Next Steps` |
| Question raised but unanswered | Append to relevant note under `## Open Questions` |

For 1:1 notes, use this structure:

```markdown
---
date: YYYY-MM-DD
description: "1:1 with <Person> — <one-line summary>"
person: <Person Name>
tags:
  - work-note
  - 1-1
---

# 1:1 with <Person> — YYYY-MM-DD

## Key Takeaways

## Action Items

- [ ] 

## Quotes / Direct Feedback

## What to Watch

## Related

- [[<Person>]]
```

### 5. Cross-Link

After routing all content:

- Every new note must link to at least one existing note
- Every existing note updated must have its Related section checked — add any new links that are now relevant
- If a person was mentioned, link to their `org/people/` note from the work note and vice versa

### 6. Clear the Inbox

After processing each file, confirm what was routed and ask:

> "Done processing `<filename>`. Delete from inbox?"

If yes, delete the file. If no, leave it and move on.

After all files are processed, present a summary:

### Summary Format

```
## Intake Complete

Processed: <N> file(s)

### Routed
- <filename> → <list of notes created or updated>
- ...

### New Notes Created
- <path>
- ...

### Action Items Captured
- [ ] <item> → <note>
- ...

### Decisions Logged
- <decision> → <note>
- ...

### Wins Added to Brag Doc
- <win>
- ...

### Items That Needed a Judgment Call
(anything you weren't sure how to classify — ask the user)
```

## Important

- **Never delete a file without confirmation** — always ask first
- If a note is ambiguous (can't tell who the meeting was with, or what project it belongs to), ask before routing
- Prefer appending to existing notes over creating new ones for small updates
- If the file has no date in its name, use today's date
- This command handles structured exports — for freeform brainstorming or ad hoc capture, use `/om-dump`
