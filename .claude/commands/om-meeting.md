---
description: "Prep for any meeting by topic — subject-forward briefing with open tasks, blockers, and brainstormed considerations the user may not have thought of yet."
---

# Meeting Prep

Deep briefing on a subject before a meeting. Leads with the topic, not the people. Surfaces what's unresolved and brainstorms considerations, risks, and angles that may not have been raised yet.

## Usage

```
/om-meeting <topic>
```

Examples:
- `/om-meeting Janus Project`
- `/om-meeting Legal sign-off workflow`
- `/om-meeting Qwen font exploration`
- `/om-meeting ComfyUI model server access`

## Workflow

1. **Search the vault** — run `qmd query "$ARGUMENTS"` and `qmd vsearch "$ARGUMENTS"` to find everything related to the topic, including semantically related content

2. **Load all related notes** — read every relevant result: work notes, decisions, incidents, person notes, team notes. A meeting about one topic often touches adjacent projects and prior decisions

3. **Build the subject picture** — synthesize what the vault knows:
   - Current status and recent changes
   - How this topic connects to other active work
   - Prior decisions that affect this topic
   - Outstanding items directly tied to this subject

4. **Surface open items** — collect all unresolved threads related to the topic:
   - Open checkboxes (`- [ ]`) from related notes
   - Documented blockers
   - Questions raised but not answered
   - Status fields with no recent movement

5. **Brainstorm considerations** — go beyond what's in the vault; think through:
   - What could go wrong that hasn't been written down yet
   - Dependencies on other teams, people, or systems not yet flagged
   - Decisions that will likely need to be made — and what the options are
   - Edge cases or failure modes worth raising
   - Things that have tripped up similar work before (check `brain/Gotchas.md`)
   - Stakeholders who aren't in the room but whose work this affects

6. **Note relevant people** — list who's involved and their role relative to this topic only (not relationship history or 1:1 context — that's `/om-prep-1on1`)

7. **Present the briefing**:

   ### Current State
   Concise synthesis of where things stand on this topic right now.

   ### Open Items
   All unresolved tasks, blockers, and unanswered questions — checklist format.

   ### Likely Decisions
   What will probably need to be decided or agreed in this meeting, with options if known.

   ### Considerations Worth Raising
   Brainstormed angles, risks, dependencies, and edge cases — especially things NOT already in the vault. This is the most valuable section.

   ### People Involved
   Who's relevant to this topic and in what capacity (role only, no 1:1 context).

   ### Questions to Ask
   Suggested questions based on gaps, risks, or unresolved threads.

## After the Meeting

Use `/om-dump` to capture outcomes, decisions, and new context — it will route everything to the right notes.

## Important

- **Lead with the subject, not the people** — this is a topic briefing, not a relationship prep
- The Considerations section is the core value — push beyond what's already documented
- If the topic has no vault notes, say so and offer to create a stub before the meeting
- Keep it scannable — the user needs to absorb this quickly before walking in
- This is NOT for 1:1 prep — use `/om-prep-1on1` for person-focused meeting prep with wins and brag context
