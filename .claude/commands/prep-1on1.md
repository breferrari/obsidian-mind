---
description: "Prep for an upcoming 1:1 — load person context, surface open items, suggest agenda based on vault state."
---

# Prep for 1:1

Prepare for an upcoming 1:1 by gathering everything relevant about the person and current work context.

## Usage

```
/prep-1on1 <person>
```

Example: `/prep-1on1 Scott Detweiler`

## Workflow

1. **Load person context** — read `org/people/$ARGUMENTS.md` for role, relationship, key moments, and any standing dynamics

2. **Load recent 1:1 history** — check `work/1-1/` for prior notes with this person; surface:
   - Unresolved action items from last meeting
   - Topics that recurred across sessions
   - Anything flagged in "What to Watch"

3. **Load active work** — read `work/Index.md` and relevant `work/active/*.md` notes; identify:
   - Projects this person is connected to (via wikilinks or shared team)
   - Blockers or open questions that need a decision or support
   - Work in progress worth giving visibility to

4. **Check North Star alignment** — read `brain/North Star.md`; flag:
   - Goals drifting or with no active work
   - Emerging focus that hasn't been written down yet

5. **Surface wins to share** — check `perf/Brag Doc.md` and the current quarter's brag note for completed work or milestones since the last 1:1 with this person

6. **Check open tasks** — run `obsidian tasks daily todo`; flag any stalled or overdue items

7. **Present the prep brief**:

   - **Who** — one-line reminder: role, relationship, standing dynamics
   - **Since Last Time** — unresolved action items, open "What to Watch" signals
   - **Wins to Share** — completed work and milestones worth mentioning, with enough context to explain impact
   - **Things to Raise** — blockers needing a decision, projects needing visibility, North Star drift
   - **Questions to Ask** — based on vault gaps or unclear priorities
   - **Suggested Agenda** — rough order if there are 3+ items: wins → updates → asks → questions

## Important

- This is prep, not a script — surface the relevant context, let the user decide what to raise
- If no prior 1:1 notes exist for this person, lean harder on active work and North Star for agenda material
- Keep the output scannable — the user is about to walk into a meeting, not read an essay
- Flag sensitive interpersonal items but don't lead with them

## After the Meeting

Run `/capture-1on1 $ARGUMENTS` to file the notes into `work/1-1/` and update the person note.
