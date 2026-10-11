# Obsidian Mind

Personal Obsidian vault for work notes, decisions, performance tracking, and persistent agent context. This is the vault's single shared instruction file. It is read natively by Codex, Claude Code, Antigravity, and trusted Grok; Gemini reads it through `.gemini/settings.json`.

## Search Before Reading

Use QMD proactively before reading files. Pick the highest available surface and stop:

1. Registered `mcp__qmd__query`, `get`, `multi_get`, or `status` tools.
2. `qmd --index <name> query|search|vsearch|get|multi-get`, where `<name>` is `qmd_index` in `vault-manifest.json` or the vault folder name slugified.
3. Grep, Glob, or Read only when QMD is unavailable.

On a fresh clone, run `node --experimental-strip-types .scripts/qmd-bootstrap.ts` once. `brain/Skills.md` is the command catalog for agents that do not auto-surface `.claude/commands/`.

## Vault Structure

| Location | Purpose |
| --- | --- |
| `Home.md` | Vault entry point and dashboards. |
| `vault-manifest.json` | Template metadata, boundaries, schemas, and upgrade fingerprints. |
| `work/active/` | Current projects only; archive completed work under `work/archive/YYYY/`. |
| `work/incidents/`, `work/1-1/`, `work/meetings/` | Incidents, 1:1s, and unprocessed meeting exports. |
| `perf/` | Brag documentation, evidence, competencies, and review artifacts. |
| `org/people/`, `org/teams/` | Atomic people and team notes. |
| `brain/` | Durable vault knowledge: Memories, Key Decisions, Patterns, Gotchas, Skills, North Star. |
| `memories/YYYY/MM/` | Cross-repo memories written through the `om` MCP server; never hand-edit. |
| `reference/` | Codebase and architecture knowledge. |
| `thinking/` | Temporary reasoning drafts; promote findings, then delete the scratchpad. |
| `templates/`, `bases/` | Templates and Obsidian Base views. |

No user notes belong at the vault root. Root infrastructure is listed in `vault-manifest.json`.

## Working In The Vault

### Start and finish

For a substantial session, run `om-standup` (Claude Code and Gemini may use `/om-standup`). It reads current goals, active work, recent changes, open tasks, and hygiene flags. If working manually, read `Home.md`, `brain/North Star.md`, `work/Index.md`, and relevant `brain/` topics.

When the user says “wrap up” or equivalent, invoke `om-wrap-up`. If it is unavailable, archive completed projects, update relevant indexes and brain notes, record meaningful wins, check links, and offer to update North Star goals.

Use `thinking/YYYY-MM-DD-topic.md` for temporary analysis. Promote durable findings to proper notes and remove the scratchpad unless the reasoning itself is worth preserving.

### Creating notes

1. Use YAML frontmatter with `date`, a roughly 150-character `description`, `tags`, and the note type's required fields. Work notes and incidents also need `quarter`; incidents need `ticket`, `severity`, and `role`.
2. Use templates. Preserve existing frontmatter when editing.
3. Write fully and split structurally. A note around 25 KB needs organization, never trimming. Move content verbatim into domain notes, event-log satellites, or an archive note; leave a one-line index and retarget inbound links.
4. File living/entity notes with bare titles. Prefix point-in-time notes with `YYYY-MM-DD`. Use real modified time in `bases/Recently Touched.base` for recency, never filename dates.
5. Give multi-note workstreams a folder under `work/active/<Topic>/`; links remain the primary organization.

### Note types

| Type | Location | Required shape |
| --- | --- | --- |
| Work note | `work/active/`, then `work/archive/YYYY/` | Context, What/Why, Links, Related. |
| Incident | `work/incidents/` | Context, Root Cause, Timeline, Impact, Analysis, Related. |
| 1:1 | `work/1-1/` | Key Takeaways, Action Items, Quotes, What to Watch, Related. |
| PR evidence | `perf/evidence/` | Person, period, projects, quality, growth, full table. |
| Person or team | `org/people/` or `org/teams/` | Atomic node linked to work and context. |
| Brain note | `brain/` | Topic-specific durable knowledge. |
| Decision | `work/` | Use the Decision Record template and link it to affected work. |

### Links and indexes

Graph-first, not folder-first: every new note must link to at least one existing note. Prefer `[[wikilinks]]`; use folders for browsing and links for meaning. Split a note when it contains three or more independently useful concepts.

Update `work/Index.md` for work, `brain/Memories.md` for a new brain topic, `brain/Skills.md` for workflows, `org/People & Context.md` for organization knowledge, and `perf/Brag Doc.md` for meaningful wins.

### Decision records

Create a decision record when any one is true: the decision is hard to reverse, surprising without context, or represents a real trade-off. Otherwise the issue and commit are sufficient. Once it qualifies, create the record, link it to the work, add it to `work/Index.md`, and add a significant one to `brain/Key Decisions.md`.

## North Star, Tags, And Properties

Read `brain/North Star.md` before substantial work, ground suggestions in it, and update it when goals change.

Use frontmatter tags, not inline tags. Common values are `work-note`, `decision`, `perf`, `thinking`, `north-star`, `competency`, `person`, `team`, `brain`, `index`, and `moc`. Use properties such as `cycle`, `person`, `team`, `status`, `quarter`, `ticket`, `severity`, and `role` so Bases and searches remain useful.

## Memory

All durable knowledge created inside this vault belongs in relevant `brain/` topic notes, linked to its context. When asked to remember something, find or create the topic note, write the lesson, and update `brain/Memories.md` when a new topic is created.

The `memories/` tree is for the `om` MCP server to write on behalf of other repositories. Do not hand-edit it. When a conversation touches a Brain Topic, query QMD for that topic before answering; read only the relevant note if QMD is unavailable.

## Other Repositories

The `om` MCP server exposes this vault to a session in another repository. Register `.claude/scripts/om-mcp.mjs` in that repository's MCP configuration, then add a short instruction in that repository's own agent file telling it when to consult the vault. Do not register raw QMD in a consuming repository: it bypasses memory scope checks. For the exact configuration and exposure model, read `ARCHITECTURE.md` → *Reaching the Vault From Another Repo*.

## Agent Guidelines

- Folders group by purpose; links group by meaning. Add links first, and prefer bidirectional links when both notes are evidence or context nodes.
- Put people in `org/people/`, teams in `org/teams/`, codebase knowledge in `reference/`, durable operational lessons in `brain/`, active work in `work/active/`, and review material in `perf/`.
- Keep project evidence, review strategy, people dynamics, and personal conversation context separate.
- Never modify `.obsidian/` configuration unless explicitly asked. Never configure git hooks or auto-commit.
- Prefer Obsidian CLI only when Obsidian is already running. Background automation should use the filesystem; the first macOS CLI call can visibly launch Obsidian.
- Always suggest useful links between notes. Every note needs a `description` field.
- Reorganize with `git mv`; do not delete data without explicit user approval.

## Write-Correctness Laws

1. A project's volatile status lives in exactly one place: its frontmatter and top status line. Other notes link to it rather than restating it.
2. When a fact changes, sweep and correct every restatement. Use `om-correct` for paraphrases; preserve historical notes that correctly describe what was believed at the time.
3. Mark unverified claims as `(TBC)`, `(unverified)`, or `(inferred)`.
4. Date-stamp volatile facts such as versions, counts, and organization structure.
5. Attribution and creation dates can legitimately differ.
6. Do not hardcode counts in instruction files or documentation tables.

## Agent Support

| Agent | Instruction loading | Known gap |
| --- | --- | --- |
| Claude Code | `AGENTS.md` plus `.claude/rules/*.md` | A root or parent `CLAUDE.md` makes Claude skip `AGENTS.md`; remove or migrate it. |
| Codex CLI | `AGENTS.md` natively, including from subfolders | Instruction content above its silent size limit can be truncated. |
| Gemini CLI | `.gemini/settings.json` loads `AGENTS.md` | A session started in a subfolder does not apply root settings; start at vault root. |
| Antigravity | `AGENTS.md` natively | Deeper hooks, skills, commands, and MCP support are tracked separately. |
| Grok | Trusted vaults load `AGENTS.md` | Trust once with `--trust` or `/hooks-trust`; deeper integration is tracked separately. |

The shared hook scripts live in `.claude/scripts/`; command prompts live in `.claude/commands/`. Their support varies by agent. Read `ARCHITECTURE.md` → *Multi-Agent Portability* when wiring an agent or debugging lifecycle behavior.

## Rules For This Repository

Follow `CONTRIBUTING.md`. Keep changes focused, do not update release metadata or `CHANGELOG.md`, and run `cd .claude/scripts && npm test` before proposing a change.
