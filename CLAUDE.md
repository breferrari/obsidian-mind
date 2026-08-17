# Obsidian Mind

Personal Obsidian vault -- an external brain for work notes, decisions, performance tracking, and Claude context.

## Skills & Capabilities

This vault has [obsidian-skills](https://github.com/kepano/obsidian-skills) installed in `.claude/skills/`. Follow these skill conventions:

- **obsidian-markdown**: Obsidian-flavored markdown -- wikilinks, embeds, callouts, properties. See `references/` for callout types, embed syntax, and property specs. Always prefer `[[wikilinks]]` over markdown links.
- **obsidian-cli**: CLI commands for vault operations when Obsidian is running. See CLI section below.
- **json-canvas**: Create `.canvas` files with nodes, edges, and visual layouts. See `references/EXAMPLES.md`.
- **obsidian-bases**: Create `.base` files with views, filters, and formulas. Bases core plugin is enabled. See `references/FUNCTIONS_REFERENCE.md`.
- **defuddle**: Extract clean markdown from web pages via `defuddle parse <url> --md`.
- **qmd**: Semantic search across the vault via [QMD](https://github.com/tobi/qmd). Use PROACTIVELY before reading files. **Preference order — pick the highest surface available and stop:**
  1. **`mcp__qmd__query`, `mcp__qmd__get`, `mcp__qmd__multi_get`, `mcp__qmd__status`** — registered MCP tools. If you see them in your tool menu, they are live and pre-scoped to this vault's index. Use them first; no `--index` argument needed.
  2. **`qmd --index <name> query|search|vsearch|get|multi-get`** — CLI fallback for one-off shell checks or when the MCP server is unavailable. Always pass `--index <name>`, where `<name>` is the `qmd_index` field from `vault-manifest.json` when set and otherwise the vault folder name slugified, so the SQLite store stays isolated from other vaults on the machine.
  3. **Grep / Glob / Read** — last resort, only when QMD is not installed at all.

  The MCP server (`.mcp.json` → `.claude/scripts/qmd-mcp.mjs`), the CLI, and the SessionStart hook all read the same manifest field, so every surface scopes to the same store. On a fresh clone, run `node --experimental-strip-types .scripts/qmd-bootstrap.ts` once to build the index. Note: the MCP connect-time banner can read "0 documents" when the server registers before the SessionStart reindex finishes — a stale snapshot, not the dead-search state the self-heal guards; don't diagnose it.

### Custom Slash Commands

Defined in `.claude/commands/`. Claude Code auto-surfaces every command with its description in the session's skills list — **that injected list is the live catalog**. Do not maintain a command table here (it drifts; the injected list can't — see Write-Correctness law 6). **Agents without that injection (Codex, Gemini, Cursor): read `brain/Skills.md`** — it carries the full command catalog plus usage docs and workflow sequences.

## Vault Structure

| Folder | Purpose | Key Files |
|--------|---------|-----------|
| `Home.md` | **Vault entry point** -- embedded Base views, quick links | Open this first |
| `vault-manifest.json` | **Template metadata** -- version, infrastructure vs user content boundaries, frontmatter schemas, version fingerprints | Used by `/om-vault-upgrade` for migration |
| `CHANGELOG.md` | **Version history** -- tracks template releases (v1--v3.3) with what changed | Reference for upgrade paths |
| `bases/` | **All Bases centralized** -- dynamic views for navigation | `Work Dashboard` (incl. Stale Actives), `Recently Touched` (recency by real mtime — the answer to "what's most recent", not filename dates), `Incidents`, `People Directory`, `1-1 History`, `Review Evidence`, `Competency Map`, `Templates` |
| `work/` | Work notes index | `Index.md` (detailed MOC) |
| `work/active/` | **Current projects only** (1-3 files) | Move here when starting, move to archive when done |
| `work/archive/YYYY/` | Completed work organized by year | Grows over time |
| `work/incidents/` | Incident docs (main note + RCA + deep dive + drafts) | Per-incident grouping |
| `work/1-1/` | 1:1 meeting notes (accumulate weekly) | Named `<Person> YYYY-MM-DD.md` |
| `work/meetings/` | **Meeting notes inbox** -- staging area for raw exports, processed by `/om-intake` | Drop files, run `/om-intake` |
| `perf/` | Performance framework, brag doc | `Brag Doc.md` (index) |
| `perf/brag/` | Quarterly brag notes | One per quarter, e.g. `Q1 2025.md` |
| `perf/competencies/` | Atomic competency notes (link targets) | One note per competency |
| `perf/evidence/` | PR deep scans, data extracts for reviews | Named `<Person> PRs - <Period>.md` |
| `perf/<cycle>/` | Review cycle briefs + artifacts | Review briefs (private, manager, peer) |
| `brain/` | Claude's operational knowledge | `Memories.md`, `Key Decisions.md`, `Patterns.md`, `Gotchas.md`, `Skills.md`, `North Star.md` |
| `memories/YYYY/MM/` | **Cross-repo agent memory** -- durable lessons recorded over MCP by sessions working in *other* repositories. Time is the only thing in the path; reach is declared in frontmatter | Browse via `bases/Memories.base`; never edit by hand |
| `org/` | Organizational knowledge index | `People & Context.md` (MOC) |
| `org/people/` | Atomic person notes | One note per person |
| `org/teams/` | Team notes as graph nodes | One note per team |
| `reference/` | Codebase knowledge, architecture maps | Flow docs, architecture docs |
| `thinking/` | Scratchpad for drafts and reasoning | Named `YYYY-MM-DD-topic.md` |
| `templates/` | Obsidian templates | `Work Note.md`, `Decision Record.md`, etc. |
| `.claude/commands/` | Slash commands (auto-surfaced in-session; catalog in `brain/Skills.md`) | One `.md` per command |
| `.claude/agents/` | Subagents | See subagents table below |
| `.claude/scripts/` | Hook scripts + the MCP server | `session-start.ts`, `classify-message.ts`, `validate-write.ts`, `pre-compact.ts`, `stop-checklist.ts`, `charcount.ts`, `om-mcp.mjs` (see **Reaching the vault from another repo** below) |
| `.claude/skills/` | Obsidian + QMD skills | Loaded automatically via Skill tool |

## Obsidian CLI

When Obsidian is running, prefer CLI over raw filesystem — it provides vault-aware search, backlink discovery, and property management. **On macOS, open Obsidian before invoking the CLI**: the first `obsidian` call launches the Electron app (visible window flash) if no instance is running; subsequent calls forward args silently. In non-interactive contexts where you can't guarantee Obsidian is open (background hooks, automation), prefer filesystem reads instead.

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

The `SessionStart` hook automatically injects rich context: vault file listing, North Star goals, active work, recent git changes, open tasks (aggregated from `work/active/` and the vault root, excluding infrastructure files), vault-hygiene drift flags (act on them or run `/om-tidy`), and triggers a QMD re-index. Most context is already loaded -- you don't need to manually read files.

**Shortcut**: Run `/om-standup` for a structured morning kickoff that reads everything and presents a summary with suggested priorities.

If doing it manually:

1. Read `Home.md` -- vault entry point with embedded dashboards
2. Read `brain/North Star.md` -- ground suggestions in current goals
3. Check `work/Index.md` -- see active projects and recent notes
4. Scan `brain/Memories.md` -- index of memory topics, then read relevant topic notes
5. `obsidian tasks daily todo` -- see pending items

### Ending a Substantial Session

**When the user says "wrap up", "let's wrap", "wrapping up", or similar -- invoke `/om-wrap-up` automatically.** This runs a full review of the session.

If `/om-wrap-up` is not invoked, at minimum do these before wrapping up:

1. **Archive completed projects**: `git mv` from `work/active/` to `work/archive/YYYY/`, update `status: completed` (or use `/om-project-archive`)
2. Update `work/Index.md` if new notes or decisions were created
3. Update the relevant brain topic note (`brain/Key Decisions.md`, `brain/Patterns.md`, `brain/Gotchas.md`) with key learnings
4. Update `org/People & Context.md` if org knowledge changed
5. Update `perf/Brag Doc.md` if wins or impact were achieved
6. Offer to update `brain/North Star.md` if goals shifted or new focus emerged
7. Verify all new notes link to at least one existing note (orphans are bugs)
8. If work demonstrates competencies, add competency links to the work note's `## Related`
9. Run `/om-vault-audit` if the session created many notes

Skip steps that don't apply. The goal is transferring durable knowledge from conversation to vault state.

### Thinking Workflow

Use `thinking/` for drafts, reasoning, and analysis before writing final notes. **Thinking notes are scratchpads, not storage.** They exist to help you reason -- once the reasoning produces durable knowledge, promote it to proper notes and delete the scratchpad.

1. Create a thinking note: `thinking/YYYY-MM-DD-descriptive-name.md`
2. Use the Thinking Note template
3. Reason through the problem, analyze options, draft content
4. Promote findings to atomic notes in the correct folder (not one monolith -- one note per distinct concept)
5. Delete the thinking note -- it served its purpose
6. If the thinking process itself is worth preserving (unusual), keep it but link to the promoted notes

### Creating Notes

1. **Always use YAML frontmatter** with at minimum `date`, `description` (~150 chars), `tags`, and type-specific fields. Work notes and incidents also need `quarter` (e.g., `Q1-2026`). Incidents need `ticket`, `severity`, `role`.
2. **Use templates** from `templates/`. Fill `{{placeholders}}` with real values.
2b. **Write fully, organize structurally — the vault tidies itself.** Size is a STRUCTURE signal, never a brevity signal: when a note crosses the ~25KB organization threshold (bytes, not lines — giant single-line entries hide in low line counts), the PostToolUse hook flags it at write time and the hygiene scan flags it at session boundaries. The response is always a SPLIT (domain notes, event-log satellites, or a cluster folder — content moved verbatim, one-liner index left behind, inbound links retargeted), never trimming content. The same hook flags write-time topic clusters — token overlap is blind, so judge genuine shared context before grouping. `/om-tidy` is the acting half. Exempt: `*Archive*` notes (bulk is their job).
3. **Place files correctly**:
   - **Active** work notes, decisions, peer review prep -- `work/active/`
   - **Completed** work notes -- `work/archive/YYYY/` (by year)
   - Incident docs -- `work/incidents/`
   - 1:1 meeting notes -- `work/1-1/`
   - Performance content -- `perf/` (cycle subfolder for review briefs)
   - PR evidence -- `perf/evidence/`
   - Competency definitions -- `perf/competencies/`
   - People -- `org/people/`
   - Teams -- `org/teams/`
   - Claude operational context -- `brain/`
   - Codebase knowledge -- `reference/`
   - Drafts -- `thinking/`
   - Vault root: `Home.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `vault-manifest.json`, `CHANGELOG.md`, `CONTRIBUTING.md`, `README.md`, `LICENSE`, `.gitignore`. No user notes at root.
4. **Name files descriptively.** Use the note title as filename. **Date convention:** prefix **point-in-time** notes with a date — 1:1s (`<Person> YYYY-MM-DD.md`), dated captures, meeting exports. **Living and entity notes use a bare title** — work notes, person/team notes, competencies, `brain/`, `reference/`. *Why the split:* a creation-date prefix on a continuously-edited note **inverts the recency signal** (a living doc looks stale while being updated daily). For "what's most recent," use `bases/Recently Touched.base` (real modified time), never filename dates.
5. **Group multi-note workstreams in a subfolder.** Once a workstream has more than one note, it gets a folder (`work/active/<Topic>/`; the archive mirrors the grouping). Folders are the lifecycle/context axis only — links remain the primary organization (wikilinks resolve by name across folders, so grouping never breaks links, QMD, or the graph). The hygiene scan and write-time cluster sensor flag candidates; `/om-project-archive` moves whole clusters.

### Note Types

| Type | Location | Naming | Key Sections |
|------|----------|--------|--------------|
| Work note | `work/active/` (then `archive/YYYY/` when done) | Descriptive title | Context, What/Why, Links, Related |
| Incident | `work/incidents/` | Ticket number or descriptive title | Context, Root Cause, Timeline, Impact, Analysis, Related |
| 1:1 note | `work/1-1/` | `<Person> YYYY-MM-DD.md` | Key Takeaways, Action Items, Quotes, What to Watch, Related |
| PR analysis | `perf/evidence/` | `<Person> PRs - <Period>.md` | PR Count, Projects, Quality, Growth, Full Table |
| Review brief | `perf/<cycle>/` | `<Cycle> Review Brief.md` | Arc, Impact, Competencies, Documentation Trail |
| Person note | `org/people/` | Full name | Role & Team, Relationship, Key Moments, Notes |
| Team note | `org/teams/` | Team name | Members, Scope, Interactions |
| Competency | `perf/competencies/` | Competency name | Definition, level criteria, Evidence (via backlinks) |
| Brain note | `brain/` | Topic name | Topic-specific content |
| Domain note | Beside its family index | `<Index> - <Domain>` (e.g. `Gotchas - Tooling`) | Substance lives here; the family index keeps a one-liner per entry. Born from monolith splits — never re-inline into the index |
| Event-log satellite | Beside its core note | `<Core> — <Event> Log` or dated title | Chronological bulk offloaded from a person/project core note; the core links it. Dated entries, verbatim moves |
| Archive note | Beside its live note | `<Live Name> Archive[ — <window>]` | Bulk by design, hygiene-exempt (name contains "Archive"). Verbatim zero-loss moves; live note keeps a one-liner index + link |

### Linking -- This Is Critical

**Graph-first, not folder-first.** Folders help browse in the sidebar. Links help discover through connections. Both matter, but links are the primary organizational tool.

**A note without links is a bug.** When creating a note, the FIRST thing to do after writing content is add wikilinks. Every new note must link to at least one existing note.

**Atomicity rule**: Before writing or appending to any note, ask: "Does this cover multiple distinct concepts that could be separate nodes?" If a note has or would have 3+ independent sections that don't need each other to make sense, split into atomic notes that link to each other.

Note types have graph roles:
- **Evidence nodes** (work notes, 1:1s, PR analyses): add outbound links to concepts they demonstrate
- **Concept nodes** (competencies, patterns): stay definitional -- evidence arrives via backlinks
- **Index nodes** (Index, Brag Doc, Memories, People & Context): actively curate links -- they're navigational
- **Person nodes** (org/people/): link to projects, teams, evidence. Receive backlinks from work notes.

Link syntax:
- `[[Note Title]]` -- standard wikilink
- `[[Note Title|display text]]` -- aliased link
- `[[Note Title#Heading]]` -- deep link to section
- `![[Note Title]]` -- embed content inline
- `[[Note Title#^block-id]]` -- link to specific block

#### When to Link

- **Work note <-> Decision**: bidirectional links
- **Work note -> Competency**: in `## Related`, link to competencies demonstrated
- **Work note -> Team**: in `## Related`, link to team(s) involved
- **Work note -> Person**: link people involved (especially in 1:1 notes)
- **Person -> PR analysis**: link to their evidence file if one exists
- **Brag Doc -> Work note**: every entry links to evidence
- **Memories -> Source**: every memory links to where it was learned
- **Index -> Everything**: `work/Index.md` links to all work notes
- **North Star -> Projects**: active focus areas link to project work notes

### Maintaining Indexes

Update these when creating or archiving notes:

- **`work/Index.md`** -- add to Active Projects or Recent Notes, move completed to Archive
- **`brain/Memories.md`** -- index of memory topics. Add new memories to the relevant topic note, not here.
- **`brain/Skills.md`** -- register vault-specific workflows and slash commands
- **`org/People & Context.md`** -- update when people, teams, or org structure changes
- **`perf/Brag Doc.md`** -- log wins with links to evidence, add new quarters as needed

### Decision Records

**When a decision earns a record.** Any ONE of these holding is enough:

- **Hard to reverse** — undoing it later costs real work (a schema, a public contract, a naming scheme).
- **Surprising without context** — a competent reader would ask "why is it like this?" and the code alone cannot answer. This is the clause that stops the next contributor from "fixing" something deliberate.
- **A real trade-off** — something was genuinely given up, so the losing option's case is worth keeping.

None hold → no record; the tracker and the commit message are enough. The gate is deliberately symmetric: it prescribes records where they are missing today, and it licenses *not* writing one everywhere else, which is what keeps the record set worth reading. Without it, records cluster where writing them was easy rather than where losing them is expensive.

Once it clears the gate:

1. Create in `work/` using the Decision Record template
2. Link from the work note(s) that led to the decision
3. Add to the Decisions Log table in `work/Index.md`
4. If significant, note in `brain/Key Decisions.md`

### Wins & Achievements

When significant work is completed, add to `perf/Brag Doc.md` with links to the work note(s). Categorize under Impact, Technical Growth, Collaboration, or Feedback.

## North Star

`brain/North Star.md` is a living document of goals and focus areas.

- **Read it** at the start of substantial sessions
- **Reference it** when suggesting priorities or trade-offs
- **Update it** when the user signals a shift in goals
- Both the user and Claude write to it

## Tags Convention

Use tags in frontmatter (not inline):

- **Type**: `work-note`, `decision`, `perf`, `thinking`, `north-star`, `competency`, `person`, `team`, `brain`
- **Index**: `index`, `moc`
- **Status** (frontmatter field): `active`, `completed`, `archived`, `proposed`, `accepted`, `deprecated`
- **Team** (frontmatter field on people + work notes): your team names, e.g. `Backend`, `Platform`, `Mobile`
- **Cycle** (frontmatter field on review-related notes): `h2-2024`, `h1-2025`, etc.
- **Person** (frontmatter field on evidence notes): full name of the person
- **Project**: as needed, e.g. `project/auth-refactor`

## Properties for Querying

Beyond tags, use these frontmatter properties to enable search and Bases views:

- `cycle: h2-2024` -- find all review material for a cycle
- `person: "Jane Smith"` -- find all evidence related to a person
- `team: Backend` -- find all notes related to a team
- `status: active` -- find active projects
- `quarter: Q1-2026` -- find all work for a quarter (used by Work Dashboard Base)
- `ticket: TICKET-123` -- find incident by ticket number
- `severity: high` -- incident severity
- `role: incident-lead` -- your role in an incident

## Memory System

**All project memories live in the vault.** The `~/.claude/` MEMORY.md is an auto-loaded index that points to vault locations. The `~/.claude/` MEMORY.md is the only file that should exist there -- it is an auto-loaded index. Never create additional memory files in that directory.

| System | Location | Purpose |
|--------|----------|---------|
| **MEMORY.md** | `~/.claude/projects/.../memory/MEMORY.md` | Auto-loaded index only. Pointers to vault notes. |
| **Vault memories** | `brain/` topic notes | Git-tracked, Obsidian-browsable, linked. All durable knowledge lives here. |
| **Cross-repo memories** | `memories/YYYY/MM/` | Written by sessions in *other* repos over MCP, under an enforced epistemic contract. See below. |

**Which one, when you are working inside the vault:** `brain/`. Always. The `memories/` tree is written by the `om` MCP server on behalf of sessions elsewhere, and the server **refuses** a write from a session running inside the vault — a memory recorded here would be scoped to the vault-as-a-project and reach only the sessions that already read every note directly. Write the note normally and let the hooks file it.

When asked to "remember" something:
1. Find or create the appropriate `brain/` topic note (Gotchas, Patterns, Key Decisions, etc.)
2. Add the knowledge there with a wikilink to context
3. Update `brain/Memories.md` index if a new topic note was created
4. Do NOT create additional files in `~/.claude/projects/.../memory/` beyond MEMORY.md -- they are not version-controlled

### When to Consult Brain Topics

The SessionStart hook injects a **Brain Topics (read on demand)** index listing each `brain/` topic note with its description and an `(empty)` marker for stub notes. Treat that index as a menu:

- When the user's message touches a topic from the index (debugging → Gotchas, "how do we usually…" → Patterns, "why did we decide" → Key Decisions, "which command / slash" → Skills), query QMD **first** before answering — call `mcp__qmd__query` with a `query` argument describing the topic (or fall back to `qmd --index <name> query "<topic>"` if MCP is unavailable). The search covers the whole vault, so filter or prioritize results whose `file` path is under `brain/`. Do not assume the topic name alone scopes the search.
- If QMD is unavailable, read the specific `brain/` note directly with the Read tool. Don't load all of `brain/` — only the one(s) matching the topic.
- Skip notes marked `(empty)` in the index — they're stubs with no substantive content.
- After answering, if the conversation produced durable knowledge, update the relevant brain note (see the "remember" workflow above).

## Reaching the Vault From Another Repo

The vault normally only helps while you are sitting in it. The **`om` MCP server** makes it reachable from a coding session running in any other repository: that session can search the vault, read notes, follow the graph, and record back into it.

### The install is two steps, and both are required

**1. Register the server** in the consuming project's `.mcp.json`:

```json
{
  "mcpServers": {
    "om": {
      "command": "node",
      "args": ["<absolute path to your vault>/.claude/scripts/om-mcp.mjs"]
    }
  }
}
```

**2. Add a short section to that project's own `CLAUDE.md`**, telling it the vault exists and to consult it.

> [!warning] Step 2 is not documentation garnish.
> **Measured:** with the server wired and *no* repo-side instruction, a session made **zero** vault calls and went on to implement a design the vault had recorded as explicitly rejected. With the instruction present, it refused and cited the note.
>
> The reason is an asymmetry in how MCP `instructions` propagate: a **prohibition** holds reliably, while a positive *"go consult the vault"* is advisory and gets skipped whenever a nearer source exists. The server can stop a session doing something; only the project's own law makes one go looking.

> [!warning] Do not register the raw `qmd` server in a consuming repo.
> It searches every note directly, with no notion of which memories were written for which project — so the repo matches against lessons meant for unrelated ones. Applying each memory's declared scope on top of the index is exactly what `om` adds, and going around it returns the **wrong** things, not merely more of them.

### What it exposes

| tool | purpose |
|------|---------|
| `search` | semantic + keyword search over exposed notes |
| `expand` | a note's graph neighbourhood — links out and backlinks |
| `recall` | durable lessons scoped to the calling repo, most specific first |
| `remember` | record a lesson that will still be true in a different repo |
| `record_work` | record what happened in this repo, filed where it belongs |
| `reason` | judgement across several notes — spawns a second session, so it takes longer |
| `health` | is the wiring intact? |

Plus notes as readable **resources**, and `recall_topic` / `prior_art` as **prompts** you invoke yourself from the `/` menu.

### `reason` — judgement across notes

The other tools answer without inference. `reason` reads the vault with a second Claude session, so it is slower and uses more — reach for it when `search` or `recall` returned the notes but not the judgement. It seeds itself from search, so there is no need to search first.

**It runs on your own CLI default model**, so the vault answers at the level you are already working at. MCP gives a server no way to see the calling session's model, so inheriting the CLI default is the closest reachable thing to "the same model I am using".

**Every call is on the record** — including one that produced no answer, since the log is written before any refusal. It lands in `.claude/om-mcp-audit.jsonl` with the question, cost, turns, terminal reason, model asked for, model that ran, wall time, and the roots the spawn was given. `health` reports the day's figure, and says *at least* when the log was too big to read whole rather than quietly under-reporting.

**It reads what this vault serves, and nothing else.** The spawn is handed the same three rules the exposure policy applies to search results: your `mcp_exposed_roots`, your `mcp_never_expose` filenames, and `private:`-tagged notes — the last two matter because they live *inside* exposed roots. Unset, that is simply your `user_content_roots`, so the boundary is whatever you already declared rather than anything this tool adds. It is also told not to read the memory root, since a memory belongs to the project it was scoped to.

**The server stays responsive while it runs.** Other tools answer normally mid-call, and a shutdown ends any spawn still in flight rather than orphaning it.

One optional key, which does not ship set:

```json
"reason": { "model": "claude-haiku-4-5" }   // pin a model instead of inheriting
```

Left unset — the default — it uses your own Claude settings.

> [!warning] If you pin a model, use a FULL id.
> `--model haiku` is not honoured by the CLI and does not error — it silently runs `claude-sonnet-5`. Bare aliases (`haiku`, `sonnet`, `opus`) are therefore dropped in favour of inheriting; anything else is passed through as written. Every answer names the model that actually ran, and says whether it was the pinned one.

If a run ends early you get **no answer**, not a truncated one, plus the evidence search already found — a partial synthesis presented as complete is the one outcome worse than none.

Answers land in `.claude/om-reasoning/` (gitignored) marked `confidence: inferred`. They are deliberately **not** recorded as memories — a spawned conclusion is reasoning, not verified knowledge, and the calling session decides whether any of it earns a `remember`.

### Which memories reach which project

This is the part worth understanding, and it is what the layer is for. Every memory declares its reach when written:

- `scope: project`, `projects: [a, b]` — reaches those repos and no others
- `scope: platform`, `platforms: [ios]` — reaches any repo on that platform
- `scope: general` — reaches everywhere

A reader never widens what the writer declared, so a sibling app on the same platform does not inherit another app's project-scoped constraints. `recall` with `explain: true` reports why each memory was shown and how many were withheld.

**Getting the reach wrong is corrected the same way any other error is** — `remember` is append-only, so re-file the lesson with the right scope and pass `supersedes: ["<its exact title>"]`. Narrowing takes effect: a superseded memory is served only where its correction can follow it, so the caller the correction excludes stops receiving the wider stale copy rather than receiving it alone with nothing to replace it.

**A repo is identified by its folder name**, which is usually right and occasionally not: two repos both called `api` share one identity, so each receives the other's memories. Write a distinct name into a `.om-project` file at the repo root to separate them — `health` reports which repo it thinks is calling and where that name came from.

### Which notes the server serves

Your vault, your notes, your session. The default is the vault's own `user_content_roots`, at the granularity it declares them (`work/active/`, not all of `work/`). Set `mcp_exposed_roots` only if this vault holds material that is **not yours to share** — employer-confidential notes, a client's data.

| key | default | meaning |
|-----|---------|---------|
| `mcp_exposed_roots` | *(empty → `user_content_roots`)* | folders whose notes may be read |
| `mcp_never_expose` | *(empty)* | filenames withheld regardless of folder |
| `memory_root` | `memories` | where cross-repo memories live |
| `mcp_inbox` | `inbox` | fallback destination for `record_work` |

`memories/` is never served as an ordinary note whatever the config says — memories carry their own scope, and the note surface would bypass it. A note tagged `private` in frontmatter is never served either.

That holds on **every** surface, including the one that reads across both. `recall` serves a promoted block out of `brain/` when a capture's `promoted:` marker carries an anchor (`promoted: "brain/Gotchas - Engineering#^om-a1b2c3"`), so a foreign repo gets the corrected version rather than the capture as first written. It asks the same exposure predicate as everything else, so a withheld or `private` note is refused there too, and a marker with no anchor still serves nothing. Write anchors with `/om-tidy` — the block you point at is what a session in another repo reads.

> [!note] Keeping vault material out of repos is the contract's job, not this list's.
> A session can read the vault directly, so narrowing what the server serves prevents nothing on its own. What works is the prohibition injected into the calling session, plus `.claude/om-mcp-audit.jsonl` (gitignored), which records every read with the calling repo.

Run `health` when something that should be in the vault cannot be found — every failure in this layer presents identically as "no results", and that tool is what tells them apart.

## Agent Guidelines

### Graph-First Thinking

- **Folders group by purpose, links group by meaning.** A note lives in ONE folder (its home) but links to MANY notes (its context).
- When creating a note, add wikilinks FIRST. A note without links is a bug.
- Prefer bidirectional links: if A links to B, B should link back to A (unless B is a concept node that receives backlinks passively).
- Before creating a new subfolder, ask: "Can I solve this with a tag, a property, or a link instead?" Folders are for browsing convenience, not for categorization.
- After every substantial session, verify new notes have at least one inbound link.

### Where to Put Things

- **Writing about a person?** -- `org/people/`
- **Writing about a team?** -- `org/teams/`
- **Writing about how the codebase works?** -- `brain/` (Patterns, Gotchas, Key Decisions)
- **Writing about what Claude should remember?** -- `brain/Memories.md` topic notes
- **Capturing a 1:1 meeting?** -- `work/1-1/`
- **Deep scanning PRs for review?** -- `perf/evidence/`
- **Creating review briefs?** -- `perf/<cycle>/`
- **Tracking active project work?** -- `work/active/`
- **Capturing an incident?** -- `work/incidents/` (use `/om-incident-capture`)
- **Dumping unstructured info?** -- use `/om-dump` to auto-classify and route everything

### Don't Mix Contexts

When capturing data from Slack, DMs, or meetings:
- **Project evidence** (PRs, technical decisions, delivery) -- goes to the relevant `work/` note
- **Review prep** (peer selection, manager strategy, brag framing) -- goes to review-related notes in `perf/` or `work/`
- **People dynamics** (feedback, relationships, career) -- goes to `org/people/` notes
- **Personal conversations** -- only capture if review-relevant; otherwise skip

## Subagents

Specialized agents in `.claude/agents/` for heavy operations. They run in isolated context windows.

| Agent | Purpose | Invoked by |
|-------|---------|------------|
| `brag-spotter` | Finds uncaptured wins and competency gaps | `/om-wrap-up`, `/om-weekly` |
| `context-loader` | Loads all vault context about a person, project, or concept | Direct |
| `correction-sweep` | Finds every note restating a corrected fact; classifies each as authoritative, restatement, or historical. Never edits | `/om-correct` |
| `cross-linker` | Finds missing wikilinks, orphans, broken backlinks | `/om-vault-audit` |
| `people-profiler` | Bulk creates/updates person notes from Slack profiles | `/om-incident-capture` |
| `review-prep` | Aggregates all performance evidence for a review period | `/om-review-brief` |
| `slack-archaeologist` | Full Slack reconstruction -- every message, thread, profile | `/om-incident-capture` |
| `vault-librarian` | Deep vault maintenance -- orphans, broken links, stale notes | `/om-vault-audit` |
| `review-fact-checker` | Verifies every claim in a review draft against vault sources | `/om-self-review`, `/om-review-peer` |
| `vault-migrator` | Classifies, transforms, and migrates content from a source vault | `/om-vault-upgrade` |

## Hooks

Five lifecycle hooks in `.claude/settings.json`:

| Hook | When | What |
|------|------|------|
| SessionStart | On startup/resume | QMD re-index + self-heal, inject North Star, active work, recent changes, tasks, file listing (folders past a note-count threshold collapse to one line), vault-hygiene drift flags (completed-not-archived, ungrouped clusters, 25KB oversize, stale open loops, meetings-inbox pressure); the whole injection is held under a byte budget — over it, low-priority sections degrade to pointers and the closing injection-size meter names each one it dropped |
| UserPromptSubmit | Every message | Classifies content (decision, incident, win, 1:1, architecture, person, project update) and injects routing hints |
| PostToolUse | After writing `.md` | Validates frontmatter + wikilinks, blocks misplaced memory files, flags notes crossing the 25KB organization threshold (split, don't trim) and write-time topic clusters |
| PreCompact | Before context compaction | Backs up session transcript to `thinking/session-logs/` |
| Stop | End of every session | Lightweight checklist reminder + concrete vault-hygiene drift findings (same scan as SessionStart). For thorough review, use `/om-wrap-up` instead. |

## Write-Correctness Laws

Each law exists because its absence caused real correction work in vaults running this template. Violating them re-creates documented failures.

1. **Single-source status.** A project's volatile status (version, counts, released/blocked, dates) lives in exactly ONE place — its note's frontmatter + top status line. Every other note **links** to it and never restates it. *Why: one wrong status statement hardened into ~8 notes downstream and had to be swept out.*
2. **Correction-sweep protocol.** When a fact is corrected, find every restatement and fix them all in the same pass. **`/om-correct "<the corrected fact>"` is the acting half** — grep alone finds only the notes that copied the wording, and the expensive half is the *paraphrase*: the same claim in different words, invisible to grep and indistinguishable from correct prose to every structural check. It is also the half most likely to survive a manual sweep, because the sweeper stops when grep goes quiet. A correction callout on top of a note whose body still says the wrong thing is NOT a correction — future sessions re-absorb the stain from the body. Notes that correctly record what was believed *at the time* are preserved, never rewritten; see Law 5.
3. **Mark inference.** Anything not verified against source (code, repo, primary doc, the person) carries an explicit `(TBC)` / `(unverified)` / `(inferred)` marker. Never state inference bare.
4. **Date-stamp volatile facts.** Counts, versions, org structure, tool maturity: write "as of YYYY-MM-DD" so staleness is self-evident instead of silent.
5. **Attribution vs. creation dates may differ** (a `quarter:` field vs. the `date:` field's quarter) — that's legitimate, not a bug to "fix".
6. **No counts in instruction files.** Hardcoded counts ("11 slash commands") in CLAUDE.md/README rot silently — describe, don't count.

## Rules

- **For "what's most recent," use `bases/Recently Touched.base` (real modified time), never filename dates** — a creation-date prefix on a continuously-edited note inverts the recency signal.

- Never modify `.obsidian/` config files unless explicitly asked.
- Preserve existing frontmatter when editing notes.
- Git sync is handled by the user's preferred method (obsidian-git, manual commits, etc.) -- don't configure git hooks or auto-commit.
- When asked to "remember" something, write to the relevant `brain/` topic note with a link to context. Never create memory files in `~/.claude/` -- they are not git-tracked.
- Prefer Obsidian CLI over filesystem when Obsidian is **already** running. On macOS, the first `obsidian` call launches the Electron app (visible window flash) if no instance is running — open Obsidian once at session start, then subsequent calls forward args silently. In non-interactive contexts where you can't guarantee Obsidian is open (background hooks, automation), prefer filesystem reads.
- **Always invoke Obsidian skills via the Skill tool** before doing vault work. Load `obsidian-markdown` when creating/editing `.md` files. Load `obsidian-cli` when running vault commands. Load `obsidian-bases` or `json-canvas` when working with those file types.
- Always check for and suggest connections between notes.
- Every note must have a `description` field (~150 chars). Claude fills this automatically.
- **Zero data loss**: when reorganizing, always use `git mv`. Never delete without explicit user confirmation.
