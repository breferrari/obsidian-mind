# Obsidian Mind

Personal Obsidian vault -- an external brain for work notes, decisions, performance tracking, and agent context.

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
| `brain/` | The agent's operational knowledge | `Memories.md`, `Key Decisions.md`, `Patterns.md`, `Gotchas.md`, `Skills.md`, `North Star.md` |
| `memories/YYYY/MM/` | **Cross-repo agent memory** -- durable lessons recorded over MCP by sessions working in *other* repositories. Time is the only thing in the path; reach is declared in frontmatter | Browse via `bases/Memories.base`; never edit by hand |
| `org/` | Organizational knowledge index | `People & Context.md` (MOC) |
| `org/people/` | Atomic person notes | One note per person |
| `org/teams/` | Team notes as graph nodes | One note per team |
| `reference/` | Codebase knowledge, architecture maps | Flow docs, architecture docs |
| `thinking/` | Scratchpad for drafts and reasoning | Named `YYYY-MM-DD-topic.md` |
| `templates/` | Obsidian templates | `Work Note.md`, `Decision Record.md`, etc. |

## Obsidian CLI

Need a CLI command? See **Obsidian CLI** in `README.md`, or run `obsidian help`.

## Commands

Commands live in `.claude/commands/` — agent-agnostic markdown with YAML frontmatter. `brain/Skills.md` is the catalog.

- **Claude Code / Gemini CLI**: invoke as `/om-standup`, `/om-dump`, etc.
- **Codex CLI**: type the command name as a regular prompt without the `/` prefix (e.g. `om-standup`). Codex will find and execute the command file.

## Search

- **qmd**: Semantic search across the vault via [QMD](https://github.com/tobi/qmd). Use PROACTIVELY before reading files. **Preference order — pick the highest surface available and stop:**
  1. **`mcp__qmd__query`, `mcp__qmd__get`, `mcp__qmd__multi_get`, `mcp__qmd__status`** — registered MCP tools. If you see them in your tool menu, they are live and pre-scoped to this vault's index. Use them first; no `--index` argument needed.
  2. **`qmd --index <name> query|search|vsearch|get|multi-get`** — CLI fallback for one-off shell checks or when the MCP server is unavailable. Always pass `--index <name>`, where `<name>` is the `qmd_index` field from `vault-manifest.json` when set and otherwise the vault folder name slugified, so the SQLite store stays isolated from other vaults on the machine.
  3. **Grep / Glob / Read** — last resort, only when QMD is not installed at all.

  The MCP server (`.mcp.json` → `.claude/scripts/qmd-mcp.mjs`), the CLI, and the SessionStart hook all read the same manifest field, so every surface scopes to the same store. On a fresh clone, run `node --experimental-strip-types .scripts/qmd-bootstrap.ts` once to build the index. Note: the MCP connect-time banner can read "0 documents" when the server registers before the SessionStart reindex finishes — a stale snapshot, not the dead-search state the self-heal guards; don't diagnose it.

## Session Workflow

### Starting a Substantial Session

Run `/om-standup`. The manual steps are in `.claude/commands/om-standup.md`.

### Ending a Substantial Session

**When the user says "wrap up", "let's wrap", "wrapping up", or similar -- invoke `/om-wrap-up` automatically.** This runs a full review of the session.

Without it, the minimum checklist is in `.claude/commands/om-wrap-up.md`.

### Thinking Workflow

Drafting before a final note? Read **Thinking Workflow** in `thinking/README.md`.

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
   - Agent operational context -- `brain/`
   - Codebase knowledge -- `reference/`
   - Drafts -- `thinking/`
   - Vault root: `Home.md`, `AGENTS.md`, `vault-manifest.json`, `CHANGELOG.md`, `CONTRIBUTING.md`, `README.md`, `LICENSE`, `.gitignore`. No user notes at root.
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
- Both the user and the agent write to it

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

| System | Location | Purpose |
|--------|----------|---------|
| **Vault memories** | `brain/` topic notes | Git-tracked, Obsidian-browsable, linked. All durable knowledge lives here. |
| **Cross-repo memories** | `memories/YYYY/MM/` | Written by sessions in *other* repos over MCP, under an enforced epistemic contract. See below. |

**Which one, when you are working inside the vault:** `brain/`. Always. The `memories/` tree is written by the `om` MCP server on behalf of sessions elsewhere, and the server **refuses** a write from a session running inside the vault — a memory recorded here would be scoped to the vault-as-a-project and reach only the sessions that already read every note directly. Write the note normally and let the hooks file it.

When asked to "remember" something:
1. Find or create the appropriate `brain/` topic note (Gotchas, Patterns, Key Decisions, etc.)
2. Add the knowledge there with a wikilink to context
3. Update `brain/Memories.md` index if a new topic note was created

### When to Consult Brain Topics

Debugging, "how do we usually…", "why did we decide"? Read **When to Consult Brain Topics** in `brain/Skills.md` first.

## Reaching the Vault From Another Repo

Connecting this vault to another repo? Read **Reaching the Vault From Another Repo** in `ARCHITECTURE.md`.

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
- **Writing about what the agent should remember?** -- `brain/Memories.md` topic notes
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

## Write-Correctness Laws

Each law exists because its absence caused real correction work in vaults running this template. Violating them re-creates documented failures.

1. **Single-source status.** A project's volatile status (version, counts, released/blocked, dates) lives in exactly ONE place — its note's frontmatter + top status line. Every other note **links** to it and never restates it. *Why: one wrong status statement hardened into ~8 notes downstream and had to be swept out.*
2. **Correction-sweep protocol.** When a fact is corrected, find every restatement and fix them all in the same pass. **`/om-correct "<the corrected fact>"` is the acting half** — grep alone finds only the notes that copied the wording, and the expensive half is the *paraphrase*: the same claim in different words, invisible to grep and indistinguishable from correct prose to every structural check. It is also the half most likely to survive a manual sweep, because the sweeper stops when grep goes quiet. A correction callout on top of a note whose body still says the wrong thing is NOT a correction — future sessions re-absorb the stain from the body. Notes that correctly record what was believed *at the time* are preserved, never rewritten; see Law 5.
3. **Mark inference.** Anything not verified against source (code, repo, primary doc, the person) carries an explicit `(TBC)` / `(unverified)` / `(inferred)` marker. Never state inference bare.
4. **Date-stamp volatile facts.** Counts, versions, org structure, tool maturity: write "as of YYYY-MM-DD" so staleness is self-evident instead of silent.
5. **Attribution vs. creation dates may differ** (a `quarter:` field vs. the `date:` field's quarter) — that's legitimate, not a bug to "fix".
6. **No counts in instruction files.** Hardcoded counts ("11 slash commands") in AGENTS.md/README rot silently — describe, don't count.

## Rules

- **For "what's most recent," use `bases/Recently Touched.base` (real modified time), never filename dates** — a creation-date prefix on a continuously-edited note inverts the recency signal.

- Never modify `.obsidian/` config files unless explicitly asked.
- Preserve existing frontmatter when editing notes.
- Git sync is handled by the user's preferred method (obsidian-git, manual commits, etc.) -- don't configure git hooks or auto-commit.
- When asked to "remember" something, write to the relevant `brain/` topic note with a link to context.
- Prefer Obsidian CLI over filesystem when Obsidian is **already** running. On macOS, the first `obsidian` call launches the Electron app (visible window flash) if no instance is running — open Obsidian once at session start, then subsequent calls forward args silently. In non-interactive contexts where you can't guarantee Obsidian is open (background hooks, automation), prefer filesystem reads.
- Always check for and suggest connections between notes.
- Every note must have a `description` field (~150 chars). The agent fills this automatically.
- **Zero data loss**: when reorganizing, always use `git mv`. Never delete without explicit user confirmation.
