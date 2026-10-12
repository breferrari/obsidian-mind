---
tags:
  - claude
  - index
---

# Thinking Space

Claude's scratchpad for reasoning, drafts, and working through problems before committing conclusions to work notes.

## How This Works

- Notes here are **working drafts**, not final output
- Named with date and context: `YYYY-MM-DD-descriptive-name.md`
- Once conclusions land in a work note or decision record, thinking notes stay as reference
- Tracked in git for portability across machines

## When to Use

- Analyzing a complex problem before writing a [[Decision Record]]
- Drafting content that will be refined into a work note
- Reasoning through trade-offs or options
- Capturing intermediate research before synthesizing

## Linking Convention

- Thinking notes link to the work note or decision they feed into via `## Feeds Into`
- The final note links back to the thinking note for audit trail

## Thinking Workflow

Use `thinking/` for drafts, reasoning, and analysis before writing final notes. **Thinking notes are scratchpads, not storage.** They exist to help you reason -- once the reasoning produces durable knowledge, promote it to proper notes and delete the scratchpad.

1. Create a thinking note: `thinking/YYYY-MM-DD-descriptive-name.md`
2. Use the Thinking Note template
3. Reason through the problem, analyze options, draft content
4. Promote findings to atomic notes in the correct folder (not one monolith -- one note per distinct concept)
5. Delete the thinking note -- it served its purpose
6. If the thinking process itself is worth preserving (unusual), keep it but link to the promoted notes
