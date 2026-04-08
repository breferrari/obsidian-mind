# Capture 1:1 Meeting

Take a meeting transcript, notes, or Gemini summary and create a structured vault note with key takeaways, quotes, action items, and DM context.

## Usage

```
/om-capture-1on1 <participant>
```

User will paste the transcript/notes. Example: `/om-capture-1on1 <name>`

## Workflow

1. **Parse the input** — handle Gemini transcripts, raw notes, or meeting summaries.

2. **Create work note** at `work/1-1/<Participant> <YYYY-MM-DD>.md` with:

   ```yaml
   ---
   date: "<meeting date>"
   description: "<one-line summary of key topics discussed>"
   tags:
     - work-note
   status: completed
   ---
   ```

3. **Structure the note** with these sections:
   - **Key Takeaways** — bullet points of the most important things discussed, grouped by topic
   - **Decisions Made** — anything agreed upon
   - **Action Items** — with checkboxes, who owns each
   - **Quotes Worth Noting** — direct quotes that reveal priorities, feedback, or dynamics (use blockquotes)
   - **What Went Well** — what landed, what resonated
   - **What to Watch** — things to monitor, concerns, ambiguous signals
   - **Context From DMs** — check relevant DMs before/after the meeting for color (ask user for channel IDs if needed)
   - **Related** — wikilinks to relevant notes

4. **Update related notes**:
   - Person's people note (add 1:1 section or update existing)
   - `work/Index.md` (add to Review Prep or Active Projects as appropriate)
   - `brain/Memories.md` if any context changed (manager dynamics, priorities, etc.)
   - `org/people/` note for the participant

5. **Check for stale context** — if the meeting reveals something that contradicts existing vault notes, flag and update.

## Important

- Preserve the conversational tone — don't over-formalize quotes
- Flag sensitive interpersonal items — note if they should stay private
- Separate what was SAID from what it MEANS (interpretation goes in "What to Watch")
- Cross-reference with DMs from the same day for fuller picture
