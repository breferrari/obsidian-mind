# Obsidian Mind

Personal Obsidian vault -- an external brain for work notes, decisions, performance tracking, and Claude context.

## Skills & Capabilities

This vault has [obsidian-skills](https://github.com/kepano/obsidian-skills) installed in `.claude/skills/`. Follow these skill conventions:

- **obsidian-markdown**: Obsidian-flavored markdown -- wikilinks, embeds, callouts, properties. See `references/` for callout types, embed syntax, and property specs. Always prefer `[[wikilinks]]` over markdown links.
- **obsidian-cli**: CLI commands for vault operations when Obsidian is running. See CLI section below.
- **json-canvas**: Create `.canvas` files with nodes, edges, and visual layouts. See `references/EXAMPLES.md`.
- **obsidian-bases**: Create `.base` files with views, filters, and formulas. Bases core plugin is enabled. See `references/FUNCTIONS_REFERENCE.md`.
- **defuddle**: Extract clean markdown from web pages via `defuddle parse <url> --md`.

## Vault Structure

| Folder | Purpose | Key Files |
|--------|---------|-----------|
| `work/` | Work notes, project tracking | `Index.md` (MOC) |
| `perf/` | Performance reviews, brag doc | `Brag Doc.md`, `Review Template.md` |
| `claude/` | Claude-facing context | `Memories.md`, `Skills.md`, `North Star.md` |
| `thinking/` | Claude's scratchpad for drafts and reasoning | Named `YYYY-MM-DD-topic.md` |
| `templates/` | Obsidian templates | `Work Note.md`, `Decision Record.md`, `Thinking Note.md` |

## Obsidian CLI

When Obsidian is running, prefer CLI over raw filesystem. It provides vault-aware search, backlink discovery, and property management. Fall back to filesystem when Obsidian is not running.

```bash
obsidian read file="Note Name"                    # Read a note
obsidian create name="Name" content="..." silent   # Create without opening
obsidian append file="Name" content="..."          # Append to note
obsidian search query="text" limit=10              # Vault-aware search
obsidian backlinks file="Name"                     # Discover connections
obsidian tags sort=count counts                    # List all tags
obsidian tasks daily todo                          # Open tasks
obsidian daily:read                                # Today's daily note
obsidian property:set name="status" value="done" file="Name"
obsidian orphans                                   # Unlinked notes
```

`file=` resolves like a wikilink (by name). `path=` for exact path from root. Use `silent` to prevent files from opening. Run `obsidian help` for full reference.

## Session Workflow

### Starting a Substantial Session

A SessionStart hook automatically injects the vault file listing into context. No need to run `ls` or `find` -- you already know what files exist.

1. Read `claude/North Star.md` -- ground suggestions in current goals
2. Check `work/Index.md` -- see active projects and recent notes
3. Scan `claude/Memories.md` -- relevant context for the task
4. `obsidian tasks daily todo` -- see pending items

### Ending a Substantial Session

Before wrapping up a session where meaningful work was done:

1. Update `work/Index.md` if new notes or decisions were created
2. Update `claude/Memories.md` with key learnings or decisions worth recalling
3. Update `perf/Brag Doc.md` if wins or impact were achieved
4. Offer to update `claude/North Star.md` if goals shifted or new focus emerged
5. Verify all new notes link to at least one existing note

Skip steps that don't apply. The goal is transferring durable knowledge from conversation to vault state.

### Thinking Workflow

Use `thinking/` for drafts, reasoning, and analysis before writing final notes.

1. Create a thinking note: `thinking/YYYY-MM-DD-descriptive-name.md`
2. Use the Thinking Note template
3. Reason through the problem, analyze options, draft content
4. Write the final work note or decision record
5. Link thinking note and final note to each other
6. Thinking notes stay as reference -- no need to delete

### Creating Notes

1. **Always use YAML frontmatter** with at minimum `date`, `description` (~150 chars), `tags`, and type-specific fields.
2. **Use templates** from `templates/`. Fill `{{placeholders}}` with real values.
3. **Place files correctly**: work notes and decisions in `work/`, drafts in `thinking/`, perf content in `perf/`, Claude context in `claude/`. Nothing in vault root except this file.
4. **Name files descriptively.** Use the note title as filename.

### Linking -- This Is Critical

Every new note must link to at least one existing note. Proactively suggest connections.

- `[[Note Title]]` -- standard wikilink
- `[[Note Title|display text]]` -- aliased link
- `[[Note Title#Heading]]` -- deep link to section
- `![[Note Title]]` -- embed content inline
- `[[Note Title#^block-id]]` -- link to specific block

#### When to Link

- **Work note <-> Decision**: bidirectional links
- **Brag Doc -> Work note**: every entry links to evidence
- **Memories -> Source**: every memory links to where it was learned
- **Skills -> Usage**: skills link to notes where used
- **Index -> Everything**: `work/Index.md` links to all work notes
- **Thinking -> Final note**: thinking notes link to what they feed into, and vice versa
- **North Star -> Projects**: active focus areas link to project work notes

### Maintaining Indexes

Update these when creating or archiving notes:

- **`work/Index.md`** -- add to Active Projects or Recent Notes, move completed to Archive, keep Decisions Log current
- **`claude/Memories.md`** -- add memories with links to source, remove outdated ones
- **`claude/Skills.md`** -- register vault-specific workflows (not obsidian-skills -- those are in `.claude/skills/`)
- **`perf/Brag Doc.md`** -- log wins with links to evidence, add new quarters as needed

### Decision Records

1. Create in `work/` using the Decision Record template
2. Link from the work note(s) that led to the decision
3. Add to the Decisions Log table in `work/Index.md`
4. If significant, note in `claude/Memories.md`

### Wins & Achievements

When significant work is completed, add to `perf/Brag Doc.md` with links to the work note(s). Categorize under Impact, Technical Growth, Collaboration, or Feedback.

## North Star

`claude/North Star.md` is a living document of goals and focus areas.

- **Read it** at the start of substantial sessions
- **Reference it** when suggesting priorities or trade-offs
- **Update it** when the user signals a shift in goals
- Both the user and Claude write to it

## Tags Convention

Use tags in frontmatter (not inline):

- **Type**: `work-note`, `decision`, `claude`, `perf`, `thinking`, `north-star`
- **Index**: `index`, `moc`
- **Status** (frontmatter field): `active`, `completed`, `archived`, `proposed`, `accepted`, `deprecated`
- **Project**: as needed, e.g. `project/my-project`

## Two Memory Systems

| System | Location | Purpose |
|--------|----------|---------|
| **Claude Code memory** | `~/.claude/` | Auto-loaded. Workflow prefs, quick-recall. |
| **Vault memories** | `claude/Memories.md` | Part of the graph. Rich, linked knowledge. |

Claude Code memory for session-level preferences. Vault memories for knowledge that benefits from linking and Obsidian browsing.

## Rules

- Never modify `.obsidian/` config files unless explicitly asked.
- Preserve existing frontmatter when editing notes.
- Git sync is handled by `obsidian-git` plugin -- don't configure git hooks or auto-commit.
- When asked to "remember" something, write to `claude/Memories.md` with a link to context.
- Prefer Obsidian CLI over filesystem when Obsidian is running.
- Follow obsidian-skills conventions for all Obsidian file types.
- Always check for and suggest connections between notes.
- Every note must have a `description` field (~150 chars). Claude fills this automatically. Enables scanning without reading full contents.
