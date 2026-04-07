---
description: "Freeform capture mode. Dump anything — conversations, decisions, incidents, wins, thoughts — and I'll route it all to the right notes with proper templates, frontmatter, and wikilinks."
---

Process the following freeform dump. For each distinct piece of information:

1. **Classify** it: decision, incident, 1-on-1 content, win/achievement, architecture, project update, person context, or general work note.
2. **Search first**: Use `qmd vsearch` (or `obsidian search` if QMD unavailable) to check if a related note already exists. Prefer appending to existing notes over creating new ones for small updates.
3. **Create or update** the appropriate note following CLAUDE.md conventions:
   - Correct folder placement (work/active/, work/incidents/, work/1-1/, org/people/, etc.)
   - Full YAML frontmatter with date, description, tags, and type-specific fields
   - All relevant [[wikilinks]] to people, projects, teams, competencies
4. **Update indexes** as needed (work/Index.md, perf/Brag Doc.md, org/People & Context.md)
5. **Cross-link**: Ensure every new note links to at least one existing note and is linked FROM at least one existing note.

After processing everything, provide a summary:
- What was captured and where each piece was filed
- Any new notes created (with paths)
- Any existing notes updated
- Any items you weren't sure how to classify (ask the user)

Content to process:
$ARGUMENTS
