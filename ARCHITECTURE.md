# Architecture

This document describes how obsidian-mind fits together — the load-bearing seams, the design choices behind them, and where to extend the system. It is aimed at contributors and anyone forking the template who wants to customize it without breaking the mechanics.

It is not a folder tour. For the day-to-day layout, read `CLAUDE.md`. For the user-facing story, read `README.md`.

---

## System Overview

obsidian-mind is a plain Obsidian vault with four systems layered on top:

1. **The vault itself** — Markdown files, frontmatter, wikilinks. Portable, git-tracked, Obsidian-browsable.
2. **A hook pipeline** — small TypeScript scripts invoked by the agent harness at lifecycle events (session start, every message, after writes, before compaction, at session end).
3. **A semantic search layer (QMD)** — a separate CLI + SQLite index + MCP server, all scoped to a named index read from `vault-manifest.json`.
4. **The `om` MCP server** — the vault as a service, so a session running in a *different repository* can search it, read notes, follow the graph, and record back into it.

The layers communicate through one coordination point: **`vault-manifest.json`**. It declares the template version, the QMD index name, which folders the server serves, where memories live, and the boundary between infrastructure files (shipped by the template) and user content (created by the human).

The fourth layer is the one that changes the shape of the system. Layers 1–3 assume the agent is *sitting in the vault*; `om` removes that assumption, which is why identity — "which repo is asking?" — becomes a first-class concept below.

```mermaid
flowchart TB
    User["Human operator"]
    subgraph Agent["Agent session INSIDE the vault"]
        Harness["Agent harness"]
        Hooks["Hook pipeline<br/>(.claude/scripts/)"]
    end
    subgraph Foreign["Agent session in ANOTHER repo"]
        FSession["Coding session"]
        FConfig[".mcp.json entry<br/>+ that repo's own CLAUDE.md"]
    end
    subgraph Vault["Obsidian vault"]
        Manifest["vault-manifest.json<br/>(source of truth)"]
        Notes["Markdown notes<br/>(work/, perf/, brain/, org/)"]
        Memories["memories/<br/>(cross-repo, scope declared per memory)"]
        Config[".claude/ .codex/ .gemini/<br/>(hook configs)"]
    end
    OM["om MCP server<br/>(om-mcp.ts)"]
    QMD["QMD<br/>(named SQLite index + embeddings)"]
    Obsidian["Obsidian app<br/>(graph, Bases, CLI)"]

    User <--> Agent
    User <--> Foreign
    User <--> Obsidian
    Harness --> Hooks
    Harness -->|"mcp__qmd__*"| QMD
    Hooks --> Manifest
    Hooks --> Notes
    Hooks --> QMD
    Config --> Hooks
    FConfig --> FSession
    FSession <-->|"MCP over stdio"| OM
    OM --> Manifest
    OM --> Notes
    OM --> Memories
    OM -->|"MCP client"| QMD
    QMD --> Notes
    QMD --> Memories
    Obsidian --> Notes
```

The vault is the persistent state. Everything else is machinery around it.

---

## Division of Responsibility

Two actors do the work, and the boundary between them is the most important design choice in the system.

**Procedural code owns the environment.** Hooks in `.claude/scripts/` classify messages, validate writes, maintain the QMD index, inject context at session start, and back up transcripts before compaction. None of this logic is in the agent's head. It runs identically whether the agent is Claude Code, Codex, or Gemini, and it produces deterministic, testable behavior — every contract in `.claude/scripts/lib/` is locked by a unit suite, run in CI on every push.

**The agent owns content.** Writing notes, choosing where to file them, adding wikilinks, updating indexes, promoting thinking drafts, drafting review briefs — these are judgments, not rules, and they live with the agent. `CLAUDE.md` documents the conventions the agent should follow; it does not replace the agent's judgment.

The two halves meet at small, well-defined handoffs: hooks inject context and routing hints through stdout, the agent reads the vault and calls Write or Edit. Neither side reaches across the boundary. This is what keeps the hooks portable (no agent-specific logic) and keeps the agent's tokens pointed at judgment rather than bookkeeping.

---

## Design Principles

Four ideas shape every decision in this template. When a change breaks one of them, it needs a very good reason.

### 1. Graph-first, not folder-first

Folders group by purpose. Links group by meaning. A note lives in one folder (its home) but links to many notes (its context). Competency notes stay definitional and receive evidence through backlinks — review prep becomes reading the backlinks panel on each competency. This is why every new note must link to at least one existing note, and why the agent is instructed to treat orphan notes as bugs.

### 2. Vault-first memory

All durable knowledge lives in the vault, inside `brain/` topic notes. The agent-specific memory indexes (`~/.claude/.../MEMORY.md`) are pointers to vault locations, never the storage themselves. This keeps memory git-tracked, machine-portable, and visible in the Obsidian graph.

The `om` server extends this outward rather than around it. A session in another repo writes into `memories/` — still Markdown, still in the graph, still yours to open in Obsidian — instead of into a private store belonging to some memory service. A generic memory server solves the wrong half of the problem: it gives you a *second* knowledge base that is not your vault.

Because those memories are written from many repos and read by many repos, each one **declares its reach when written** — which projects and platforms it applies to. A reader never widens what a writer declared. That is a relevance rule, not an access-control rule: the store is the user's, the sessions are the user's, and the question being answered is "which lessons bear on the repo asking?" — not "who is allowed to know this?"

### 3. Progressive disclosure

`SessionStart` injects a small block of lightweight context (North Star excerpt, git summary, tasks, file listing). Full note contents are pulled on demand via QMD semantic search. A full file read is a last resort, not a default.

Session cost stays flat regardless of vault size because it is **enforced**, not merely intended. Two of those inputs grow with the vault — the file listing grows with every note, the North Star excerpt with every status edit — so without a ceiling the eager layer drifts upward a little every day and nobody notices until a session is paying for it. A byte budget holds the total; over it, the cheapest-to-lose sections degrade to pointers, worst-priority first, and the closing size meter names each one it dropped. Line-based caps cannot do this job: shortening entries under a line cap just slides the window deeper and refills it. Budget and listing-collapse threshold are set in `vault-manifest.json`.

**The budget is a runaway guard, not a squeeze — set it above everything worth injecting.** The meter is the detector; the budget is only the emergency brake. A ceiling low enough to bite in normal use degrades your context every session instead of catching a problem, and the two failures are not symmetric: a ceiling set too high still leaves the drift visible in the meter every session, while one set too low silently removes context you never learn you were missing. If the budget starts firing, the right response is usually to raise it and look at what grew — not to accept running degraded.

The same asymmetry decides *what* may degrade. Rank the eager layer by **value density, not size**: filenames are the cheapest bytes (one Glob rebuilds them), so the listing surrenders first. Anything irreplaceable — identity, personal context, correctness guards — carries no fallback and is never traded for plumbing. Optimizing this layer means removing **duplication**, not **information**, which is exactly why re-entry via resume/compact drops the static bulk: it is already in the conversation, so omitting it loses nothing.

### 4. Agent-agnostic core

The hook scripts, subagent prompts, command definitions, and vault conventions are pure Markdown and TypeScript with no SDK dependencies. Each agent (Claude Code, Codex CLI, Gemini CLI) brings its own config file pointing at the same scripts. Only the `~/.claude/` auto-memory loader is Claude Code-specific.

---

## The Manifest as Source of Truth

`vault-manifest.json` is the one file that every layer reads. It answers seven questions:

| Question | Field |
|----------|-------|
| What version of the template is this? | `version`, `released`, `version_fingerprints` |
| What does QMD call its store? | `qmd_index`, `qmd_context`, `qmd_min_version` |
| Which files are template infrastructure? | `infrastructure[]` |
| Which files are user content? | `user_content_roots[]`, `scaffold{}` |
| What frontmatter is required for each note type? | `frontmatter_required{}` |
| Which notes does the `om` server serve, and where do memories live? | `mcp_exposed_roots[]`, `mcp_never_expose[]`, `memory_root`, `mcp_inbox` |
| How much context may the eager layer spend? | `eager_layer_budget_bytes`, `listing_collapse_threshold` |

The `qmd_index` field is the most load-bearing. **Five independent callers** read it, and they fail *silently* when they disagree — one writes to a store another never reads, which surfaces only as "0 documents" or as an empty search:

```mermaid
flowchart LR
    Manifest["vault-manifest.json<br/>qmd_index, or the folder slug"]
    Boot["qmd-bootstrap.ts<br/>(one-time setup)"]
    SessionStart["SessionStart hook<br/>(session-start.ts)"]
    MCP[".mcp.json wrapper<br/>(qmd-mcp.mjs)"]
    Refresh["Mid-session refresh<br/>PostToolUse / Stop / PreCompact<br/>→ qmd-refresh-run.ts worker"]
    OM["om MCP server<br/>(mcp-context.ts)"]
    Store[("QMD SQLite store<br/>named per vault")]

    Manifest --> Boot
    Manifest --> SessionStart
    Manifest --> MCP
    Manifest --> Refresh
    Manifest --> OM
    Boot -->|"create + first index"| Store
    SessionStart -->|"re-index at startup"| Store
    Refresh -->|"debounced refresh"| Store
    MCP -->|"search tools"| Store
    OM -->|"search, and re-index after a write"| Store
```

All five resolve the name through one function, `resolveQmdIndex` — the `qmd_index` field when pinned, otherwise the vault folder name slugified — so the vault coexists with other QMD-indexed projects on the same machine without collision. The template ships the field empty so two installs never share a store by default. Set `qmd_index` and the next bootstrap creates a fresh, isolated store under that name.

Routing every caller through one resolver is the fix for a real class of failure rather than a tidiness preference: a hardcoded or independently-derived name in any one of the five produces a vault that indexes into one store and searches another, with nothing anywhere reporting an error. `health` on the `om` server checks that the index it would query actually belongs to this vault.

The `infrastructure[]` vs `user_content_roots[]` split is what makes `/om-vault-upgrade` work. When importing from an older template, the migrator overwrites infrastructure files wholesale and preserves user content untouched.

---

## Lifecycle Hooks

Five hooks run at different moments in a session. Each is a small Node script invoked via `--experimental-strip-types` (TypeScript executes directly, no build step).

```mermaid
sequenceDiagram
    participant User
    participant Agent
    participant Hooks
    participant Vault
    participant QMD

    User->>Agent: start session
    Agent->>Hooks: SessionStart
    Hooks->>Vault: read North Star, git log, tasks, file listing
    Hooks->>QMD: re-index (async)
    Hooks-->>Agent: inject a briefing, held under the byte budget

    loop each user message
        User->>Agent: prompt
        Agent->>Hooks: UserPromptSubmit
        Hooks->>Hooks: classify (decision, incident, win, 1:1, ...)
        Hooks-->>Agent: routing hints
    end

    loop each Write/Edit to .md
        Agent->>Hooks: PostToolUse
        Hooks->>Hooks: validate frontmatter + wikilinks
        Hooks->>QMD: debounced refresh (detached)
        Hooks-->>Agent: warnings if invalid
    end

    Note over Agent,Hooks: if context fills
    Agent->>Hooks: PreCompact
    Hooks->>Vault: back up transcript to thinking/session-logs/

    User->>Agent: end session
    Agent->>Hooks: Stop
    Hooks-->>Agent: wrap-up checklist reminder
```

A few specific design choices are worth calling out:

- **`SessionStart` injects, it does not load.** It builds a briefing (filename listing, North Star excerpt, git summary, open tasks aggregated from `work/active/` and the vault root) and hands it to the agent. Full note contents never flow through this hook. Its size is bounded by `eager_layer_budget_bytes` and reported by the meter on the last line of every injection, so the cost is visible rather than assumed. The open-tasks scan is filesystem-only so the hook never spawns the Obsidian CLI — that subprocess flashes the Electron app on macOS when no instance is running (#83).
- **`UserPromptSubmit` classifies, it does not route.** It tags the prompt with hints like `ARCHITECTURE discussion` or `DECISION`; the agent decides where to file. Keeping the hook opinion-free means the routing logic lives in `CLAUDE.md`, which is editable per-user without touching scripts.
- **QMD refresh is shared, debounced, and detached.** Three hook entries fire the same refresh helper — `PostToolUse` (after `.md` writes), `PreCompact` (before transcript backup; writes tend to cluster before compaction), and `Stop` (end of session) — sharing one sentinel file so a burst of events produces at most one worker per debounce window. The actual indexing runs in `.claude/scripts/qmd-refresh-run.ts` as a detached, stdio-silent worker (`qmd update` → `qmd embed` → tail-chase `qmd update`), so the parent hook returns in milliseconds and nothing flows to the agent's context.
- **`PreCompact` also backs up the transcript.** In addition to kicking the QMD refresh, it copies the current session transcript out to `thinking/session-logs/` so long conversations remain recoverable after compaction.
- **`Stop` is deliberately lightweight.** Beyond triggering the shared refresh, it only prints a short checklist. For a thorough review, the user invokes `/om-wrap-up` explicitly. Putting heavy logic in a Stop hook would slow every session exit and surprise the user.

---

## QMD Integration

QMD provides semantic search. It is the mechanism behind most of the agent's retrieval intelligence. Four entry points all read from the same named index:

| Caller | Entry point | When |
|--------|-------------|------|
| Agent tool menu | `.mcp.json` → `qmd-mcp.mjs` | Every `mcp__qmd__*` tool call from a session inside the vault |
| Session startup | `session-start.ts` | Re-index on every new session |
| Mid-session refresh | `validate-write.ts` / `stop-checklist.ts` / `pre-compact.ts` → `lib/qmd-refresh.ts` (shared sentinel + debounce) → detached `qmd-refresh-run.ts` | After `.md` writes, at session end, and before compaction |
| The `om` server | `lib/mcp-qmd-client.ts` (search) and `reindexSync` (after a write) | Every `search`, every queried `recall`, every `remember` / `record_work` |

Every `qmd update` invocation re-reads the per-index YAML (`~/.config/qmd/<index>.yml`), so changes to the collection config — including the ignore list synced from `.obsidian/app.json` — propagate to every surface without a session restart.

### What QMD actually runs

Worth understanding, because it explains the cost profile of everything built on top. QMD runs **three small models locally**. There is no API key, no per-query cost, and it works offline.

| model | size | job |
|---|---|---|
| `embeddinggemma-300M` | ~328 MB | turns notes and queries into vectors |
| `qmd-query-expansion-1.7B` | ~1.28 GB | rewrites a query into better search terms, and writes hypothetical answers for HyDE |
| `Qwen3-Reranker-0.6B` | ~640 MB | reorders the shortlist by actual relevance |

They download on first use and are cached. QMD offloads to the GPU when it finds one — CUDA on a discrete card, Metal on Apple Silicon — and falls back to CPU otherwise. `qmd doctor` reports which.

The CLI verbs map onto that stack, cheapest first:

| verb | what runs | cost |
|---|---|---|
| `qmd search` | BM25 keyword matching, **no model at all** | instant |
| `qmd vsearch` | vector search — embeds the query, then compares | one embed |
| `qmd query` | the full hybrid: sub-queries, then rerank | embed + optional expansion + rerank |
| `qmd update` | parse and index note **text** | no model |
| `qmd embed` | build the **vectors** for new or changed notes | the embedding model, per note |

Two consequences shape the design of everything downstream:

- **`update` and `embed` answer different questions.** `update` decides whether a note is *findable at all*; `embed` decides only where it *ranks*. They are separated everywhere in this template, and the split is why a write can report success honestly without waiting on a local model run.
- **Reads are the expensive side, not writes.** A query has to embed before it can search, so a semantic lookup costs a model pass while a keyword lookup costs none. This is the opposite of the usual database intuition, and it is why the retrieval paths below are careful about *when* they pay for a vector.

```mermaid
flowchart LR
    subgraph Text["Text path — no model"]
        Update["qmd update"]
        FTS[("BM25 / FTS index")]
        Update --> FTS
    end
    subgraph Vector["Vector path — local models"]
        Embed["qmd embed"]
        Emb["embeddinggemma-300M"]
        Vec[("vector index")]
        Embed --> Emb --> Vec
    end
    subgraph Read["Query time"]
        Q["qmd query"]
        Expand["qmd-query-expansion-1.7B<br/>expansion + HyDE"]
        Rank["Qwen3-Reranker-0.6B"]
        Q --> Expand
        Q --> Rank
    end
    FTS --> Q
    Vec --> Q
    Notes["Markdown notes"] --> Update
    Notes --> Embed
```

```mermaid
flowchart TB
    subgraph Reader["Agent tools"]
        MCP_get["mcp__qmd__get"]
        MCP_query["mcp__qmd__query"]
        MCP_multi["mcp__qmd__multi_get"]
        MCP_status["mcp__qmd__status"]
    end
    subgraph Writer["Index maintenance"]
        Boot["qmd-bootstrap.ts<br/>(one-time)"]
        Session["session-start.ts<br/>(per session)"]
        Refresh["qmd-refresh-run.ts<br/>(per write/stop/pre-compact,<br/>debounced, detached)"]
    end
    Wrapper["qmd-mcp.mjs<br/>(reads qmd_index from manifest)"]
    CLI["qmd CLI<br/>(--index &lt;name&gt; from manifest)"]
    Store[("Named SQLite store<br/>+ embeddings")]

    MCP_get --> Wrapper
    MCP_query --> Wrapper
    MCP_multi --> Wrapper
    MCP_status --> Wrapper
    Wrapper --> Store
    Boot --> CLI
    Session --> CLI
    Refresh --> CLI
    CLI --> Store
```

QMD is technically optional. When it isn't installed at all, the agent falls back through a preference order defined in `CLAUDE.md` and the qmd skill: MCP tools first when registered, then the `qmd` CLI, then Grep/Glob/Read as a last resort. Every fallback step is non-fatal: `.mcp.json` entries that fail to launch are skipped with a harmless warning, the hook scripts detect a missing `qmd` binary and no-op, and the operating manual tells the agent what to reach for next.

### QMD over MCP — the in-vault retrieval path

> This section is about the **`qmd`** MCP server, which a session *inside* the vault uses. The **`om`** server, which a session in another repo uses, is a different thing built on top of it — see [Reaching the Vault From Another Repo](#reaching-the-vault-from-another-repo). The one rule connecting them: a consuming repo registers `om`, never raw `qmd`.

When the MCP server is registered, the agent's normal path to QMD is through typed tools — `mcp__qmd__query`, `mcp__qmd__get`, `mcp__qmd__multi_get`, and `mcp__qmd__status` — that appear in its tool menu alongside Read and Edit. These come from the [Model Context Protocol](https://modelcontextprotocol.io) server declared in `.mcp.json`, launched by a thin wrapper (`.claude/scripts/qmd-mcp.mjs`) that reads `qmd_index` from the manifest and invokes `qmd mcp` underneath. The CLI remains available — and is documented as the fallback — but during a session with MCP live, the agent goes through typed tools, not shell.

The wrapper exists so that each vault can run its own isolated index without users hand-editing `.mcp.json`. The index name flows from the manifest into the wrapper, the wrapper into QMD, QMD into its per-vault SQLite store.

The contract matters because the alternative — teaching every subagent and slash command to shell out to `qmd search` on every call — would couple each prompt to QMD's CLI surface, duplicate parse/retry logic across files, and force every prompt to re-explain the tool. MCP collapses all of that into one typed interface for the in-session path. When QMD changes its CLI, the wrapper adapts; the rest of the template is insulated. When another MCP-aware service needs to join the vault (a bug tracker, a docs search, a calendar), it registers in `.mcp.json` and gains the same privileged position.

### One ignore list, two engines

Obsidian and QMD both need to know which files to hide from search. Rather than maintain two lists that can drift, the template treats `.obsidian/app.json` → `userIgnoreFilters` as the single source of truth. `qmd-bootstrap.ts` reads that array and writes it into the QMD per-index YAML (`~/.config/qmd/<index>.yml`) as the collection's `ignore` field. Every subsequent `qmd update` (initial index, mid-session refresh, session-start reindex) honors the list.

```mermaid
flowchart LR
    App[".obsidian/app.json<br/>userIgnoreFilters"]
    Boot["qmd-bootstrap.ts"]
    YAML["~/.config/qmd/&lt;index&gt;.yml<br/>collections.&lt;name&gt;.ignore"]
    Obs["Obsidian<br/>(search, graph, switcher)"]
    QmdUpdate["qmd update<br/>(every invocation)"]

    App --> Obs
    App --> Boot
    Boot --> YAML
    YAML --> QmdUpdate
```

This is why the list lives in Obsidian's config and not `vault-manifest.json`: users who adjust what's hidden in Obsidian's UI get the same change propagated to QMD on the next bootstrap. Files that are infrastructure (template dev docs like this one, `CHANGELOG.md`, `CONTRIBUTING.md`) are good candidates; user-authored content should not be here.

---

## Reaching the Vault From Another Repo

Everything above assumes the agent is running *inside* the vault. The `om` MCP server removes that assumption.

### The problem, precisely

A session working in your app's repo has no durable memory of why anything was decided. It re-derives context every time, asks you, or guesses. The knowledge exists — it is in your vault — but the session is in a different directory with no way to reach it.

Bolting a generic memory server onto that session solves the wrong half. Those write to their own store, in their own shape, and you end up with a second knowledge base that is not your vault, not in your graph, and not yours to browse. `om` exposes the vault itself.

### An MCP server is four surfaces, not one

The non-tool surfaces turned out to matter more than expected, so it is worth naming all four and which direction each runs.

| surface | direction | what it is | who triggers it |
|---|---|---|---|
| `instructions` | vault → session | the vault's rules, injected into the calling session's system prompt at connect | automatic, once per connection |
| `tools` | session → vault | `search`, `expand`, `recall`, `remember`, `record_work`, `health` | the **model** decides |
| `resources` | session → vault | notes listable and readable by `vault://note/<path>` URI | the model or the client |
| `prompts` | you → vault | `recall_topic`, `prior_art` — slash commands in the calling session | the **human** decides |

The split between rows 2 and 4 is load-bearing, because of an asymmetry measured while building this:

> **Prohibitions propagate. Routing instructions do not.**

A rule in `instructions` — *"never put a session URL in a commit"* — held under direct pressure and under an authority override. A positive instruction — *"consult the vault before answering questions about past decisions"* — is advisory and gets skipped whenever a nearer source exists. **A server can stop a session doing something; it cannot make one go looking.**

That is why `prompts` exist (the human invokes them, so no model decision is involved) and why the install requires a pointer in the *consuming repo's own* `CLAUDE.md` — the nearest source wins, so the nearest source has to be the thing that says "go look."

### The tier ladder

| tier | what | cost at call time |
|---|---|---|
| **0 — presence** | the contract reaches the calling session | one-off, no extra session spawned |
| **1 — retrieval** | `search`, `expand`, resources | seconds, **no model call** beyond the local embedding |
| **2 — capture** | `recall`, `remember`, `record_work` | no model call |
| 3 — reasoning | a spawned session that reads and reasons | a full session, billed to the user — tracked in #158, not shipped |

Tier 0 is the counterintuitive one. The original design assumed the vault would have to *think* for you: spawn its own session, hand back an answer. That works and it is expensive. Tier 0 instead hands the calling session the vault's contract and lets it think with the model you are already paying for.

### Module map

The entry script is deliberately thin. It owns only what a test cannot usefully drive — resolving the vault, opening stdio, holding the lazy qmd child. Every decision worth arguing about lives in a library module that can be driven in-process.

```mermaid
flowchart TB
    Entry["om-mcp.ts<br/>vault resolution · stdio · qmd child lifecycle"]
    Proto["mcp-protocol.ts<br/>JSON-RPC framing · identity handshake"]
    Ctx["mcp-context.ts<br/>vault root · manifest · index name<br/>INSTRUCTIONS · PROMPTS"]
    Server["mcp-server.ts<br/>method → behaviour wiring"]
    Tools["mcp-tools.ts<br/>tool declarations + annotations"]
    Exp["mcp-exposure.ts<br/>which notes are served"]
    Qmd["mcp-qmd-client.ts<br/>qmd MCP client + result filter"]
    Graph["mcp-graph.ts<br/>expand: links out, links back"]
    Caller["mcp-caller.ts<br/>identity · sanitise · audit log"]
    Bridge["mcp-memory-bridge.ts<br/>memory ↔ vault seam"]
    Capture["mcp-capture.ts<br/>record_work filing"]
    subgraph Core["Memory core — no MCP knowledge at all"]
        MW["memory-write.ts"]
        MR["memory-recall.ts"]
        MS["memory-similarity.ts"]
        MSup["memory-supersede.ts"]
        MD["memory-discover.ts"]
    end

    Entry --> Proto
    Entry --> Ctx
    Entry --> Server
    Entry --> Qmd
    Entry --> Caller
    Server --> Tools
    Server --> Exp
    Server --> Graph
    Server --> Bridge
    Server --> Capture
    Server --> Core
    Graph --> Exp
    Qmd --> Exp
    Bridge --> Core
    Bridge --> Qmd
```

The memory core knows nothing about MCP. That is what lets the epistemic contract be hammered by tests without an MCP client, a vault on disk, or a search index.

### Connection: the identity handshake

Almost everything this server does depends on **who is asking**. MCP provides that: the server can ask the client which directories the calling session has open (`roots/list`). It is derived from the client, never declared by the caller, so there is no argument through which a session could claim to be a project it is not.

The complication is that the handshake is *asynchronous*, and the client's first `resources/list` arrives before it resolves.

```mermaid
sequenceDiagram
    participant Client as Calling session
    participant Server as om server
    participant Repo as The repo on disk

    Client->>Server: initialize
    Server-->>Client: capabilities + INSTRUCTIONS
    Note over Client: instructions land in the system prompt
    Client->>Server: notifications/initialized
    Server->>Client: roots/list (server-initiated)

    par the client asks early
        Client->>Server: resources/list
        Note over Server: WAITS on identityReady, capped at 2s
    and identity is still in flight
        Client-->>Server: roots result
        Server->>Repo: read .om-project, else use folder name
        Note over Server: identity resolved, gate opens
    end

    Server-->>Client: resources scoped to this caller
```

Announcing `notifications/resources/list_changed` after the fact was tried first, and the client did not re-fetch — the listing simply stayed unscoped. The deterministic fix is the wait: **something that scopes by caller must not answer before it knows the caller.** The cap matters too — a client that never answers gets an anonymous, general-only view rather than a hang.

The same gate reopens on `notifications/roots/list_changed`. Without that, a tool call arriving between the notification and the reply was served under the *stale* identity: the same race, one step later in the lifecycle.

**Identity resolution:**

```mermaid
flowchart TB
    R["the first root URI<br/>from the handshake"] --> P["rootToPath<br/>file:// → plain path"]
    P --> M{".om-project<br/>at the root?"}
    M -->|"yes, and it is a valid name"| D["declared identity"]
    M -->|no| F["folder name, lowercased"]
    D --> Out["caller project"]
    F --> Out
    Out --> Plat["platforms: read from<br/>the project's own vault note"]
```

The folder name is right until it isn't: two repos both called `api` share one identity and therefore each other's memories. `.om-project` resolves that, and `health` reports which source was used so the collision is discoverable rather than mysterious.

### Which notes the server serves

```mermaid
flowchart TB
    Start["resolveExposure"] --> A{"mcp_exposed_roots<br/>declared?"}
    A -->|yes| Man["source: manifest"]
    A -->|no| B{"user_content_roots<br/>present on disk?"}
    B -->|yes| Der["source: derived"]
    B -->|no| Fall["source: fallback<br/>brain, reference"]
    Man --> Strip["strip the memory root — always"]
    Der --> Strip
    Fall --> Strip
    Strip --> Walk["walk each root, max depth 4"]
    Walk --> S{"entry is a symlink?"}
    S -->|no| C{"filename in<br/>mcp_never_expose?"}
    S -->|yes| Cont{"target resolves<br/>inside the root?"}
    Cont -->|"no, or broken"| Drop["not served"]
    Cont -->|yes| C
    C -->|yes| Drop
    C -->|no| E{"tagged private<br/>in frontmatter?"}
    E -->|"yes, or unreadable"| Drop
    E -->|no| Serve["served"]
```

The default is the vault's own `user_content_roots`, at the granularity the manifest declares them — `work/active/`, not all of `work/`. Roots are **path prefixes**, matched on whole segments, so `work/active` does not admit `work/active-secrets`.

`mcp_exposed_roots` narrows that, and exists for the unusual vault holding material that is *not the user's to share* — employer-confidential notes, a client's data. Both exposure keys ship empty: the template must not impose one vault's sensitivities on every install.

> **What this list is, and is not.** It decides which notes the server *serves*. It is not an egress control: a session started with `--add-dir` reads the whole vault regardless, so narrowing the read surface prevents nothing on its own. Keeping vault material out of a public PR is the job of the **prohibition in `instructions`** — the form measured to hold — plus the **audit log**. Reading this list as a security boundary leads to a narrow default, and a narrow default fences off the user's own project notes, which are the single most useful thing a coding session could read.

Three things hold regardless of configuration:

- **`memories/` is never served as an ordinary note.** Memories carry their own declared reach, evaluated per caller; the note surface would bypass it. It is stripped from the root list unconditionally, and again during the walk.
- **A symlink is contained before it is followed.** The walk `lstat`s each entry — which describes the entry rather than its target — and resolves any link against the root's realpath. Enumerating with `stat` instead means a `.md` link inside an exposed root pulls in a file from anywhere on disk.
- **Every read is logged** to `.claude/om-mcp-audit.jsonl` (gitignored, rotated at 5 MB, one generation kept) with the calling repo — so "what did that session actually see" is answerable afterwards.

Every read surface resolves through `visibleFiles`. `search` filters its hits against it, `expand` computes backlinks only over it, and the resource enumerators build from it. This is one implementation rather than three because the recurring defect in this layer is a *second* read path that reaches notes by its own route and applies a different rule.

The symlink case is that defect in its most recent form, and worth keeping as the worked example: `resolveResourceUri` did realpath containment from the start, while the enumerator followed links silently. So the resource *listing* published an out-of-vault file's description and `expand` returned its body, while reading the very same URI was refused. Both ends now contain against the **matched declared root** — not the first path segment, since roots are prefixes and `work/active/` and `work/1-1/` share one.

### A `search` call, end to end

```mermaid
sequenceDiagram
    participant Session as Calling session
    participant OM as om server
    participant Exp as mcp-exposure
    participant QC as qmd client
    participant QMD as qmd MCP server

    Session->>OM: tools/call search with query and limit
    OM->>OM: await identityReady()
    OM->>Exp: allowedSearchPaths(vault, policy)
    Exp-->>OM: set of vault-relative keys
    OM->>QC: qmdSearch(allowed, query, limit)
    QC->>QC: subQueries → lex + vec (+ hyde if question-shaped)
    QC->>QMD: tools/call query, limit = max(limit*4, 20)
    QMD-->>QC: structuredContent.results — the WHOLE vault
    QC->>QC: filter each hit against allowed
    QC-->>OM: text + withheld + total
    OM->>OM: audit the call — query, withheld, total
    OM-->>Session: ranked passages with note paths
```

Four details in that flow are decisions rather than mechanics:

**The server is an MCP *client* of the vault's own qmd server.** Reusing the existing launcher inherits two fixes for free — the Windows `.cmd` shim workaround and the named-index pin — and the launcher is *located* rather than hardcoded, because a stale path here kills search silently.

**Filter the result, never the query.** The index covers the whole vault, including memories and any folder outside the served roots. Filtering the query would require every caller to construct a scoped query correctly; filtering the result means no query a caller can write returns more than the policy serves. Refusing to answer when `structuredContent` is absent belongs to the same rule — qmd's human-readable summary carries note paths too, so falling back to it would return results nothing ever checked.

**Over-fetch, then trim.** Because the filter runs on the result, asking qmd for exactly `limit` means a vault with much unserved content returns far fewer than requested with no sign that more existed. The client asks for `max(limit * 4, 20)`.

**HyDE is conditional.** `lex` and `vec` always go out together — keywords find the exact term, vectors find the note that answers the question without using the word. `hyde` writes a hypothetical answer and matches against *that*, which is what finds the note whose title shares no words with the question. It runs a local generation model, so it is added only for queries that are at least four words *and* question-shaped. A two-word keyword lookup, where lexical matching is already the right tool, does not pay for it.

**Degradation is explicit.** qmd is optional in this template. A failed call degrades that one search and says so; it must never present as "the vault is empty". The client tracks liveness, so one qmd crash does not disable search for the life of the server, and the entry script replaces a dead child behind a 5-second cooldown so a permanently-broken qmd cannot fork a process per call.

### Which memories reach which repo

This is the part the layer exists for. Every memory declares its reach **when written**, and a reader never widens what a writer declared.

```yaml
scope: project              # general | platform | project
projects: [atlas, atlas-api]  # a LIST — the multi-valued axis
platforms: [ios]
confidence: verified
origin: atlas               # derived from the roots handshake, not caller-asserted
session: 2026-07-26T14:02:11Z
```

The list is the load-bearing choice. **A memory is multi-valued; a folder is not.** A lesson touching two projects and a cross-cutting theme has no correct folder — you would pick one and lose the rest, or duplicate and have two sources of truth. A `memories/<project>/` taxonomy was designed and rejected for exactly this. Time is the only thing in the path, because it is the only single-valued fact about a memory:

```
memories/2026/07/2026-07-26 <title>.md
```

Visibility is evaluated in order, and the order **is** the design:

```mermaid
flowchart TB
    M["a memory"] --> S1{"scope: general?"}
    S1 -->|yes| V["visible"]
    S1 -->|no| S2{"the projects list names<br/>the calling repo?"}
    S2 -->|yes| V
    S2 -->|no| S3{"scope: platform<br/>AND platforms overlap?"}
    S3 -->|yes| V
    S3 -->|no| H["not visible — default deny"]
```

- `general` reaches everyone. The only scope that does, which is why the write path polices it hardest.
- **An explicit project listing always wins**, whatever the declared scope. This is what makes the multi-project case work: `projects: [a, b]` reaches both, and neither has to know the other exists.
- `platform` reaches any caller sharing a platform — an iOS lesson reaches the next iOS app and must *not* reach the web one.
- Otherwise, not visible. A near-miss does not surface.

A caller with no roots sees `general` only: the safest reading of "I don't know who you are", and it degrades to useless rather than to wide-open.

**Ranking, once visibility has decided the set:**

```mermaid
flowchart LR
    A["superseded sinks<br/>below live"] --> B["specificity<br/>project &gt; platform &gt; general"]
    B --> C["date, newest first"]
    C --> D["session timestamp<br/>breaks same-day ties"]
```

A memory naming *only* your project outranks one naming five. `date` is day-granular, so without the session tiebreak a just-written memory could sort arbitrarily and fall outside the caller's limit.

**Adding a query on top:**

```mermaid
sequenceDiagram
    participant S as Session
    participant OM as om server
    participant MR as memory-recall
    participant QC as qmd

    S->>OM: recall {query, limit, explain}
    OM->>MR: recall(vault, caller)
    MR-->>OM: visible set, ranked by declaration
    alt query given and more than one result
        OM->>QC: semanticMemoryOrder(query, visible)
        alt index answered
            QC-->>OM: reordered
        else index down or no structured results
            QC-->>OM: null
            OM->>OM: lexical fallback — per-token, title AND body
        end
        OM->>OM: regroup — live first, superseded after
    end
    OM-->>S: entries with facets, reasons, and withheld count
```

Three properties in that path each closed a real defect:

- **Retrieve semantically, then filter by visibility — never the reverse.** The index sees every memory including other projects'. Applying the scope rule to the *result* keeps one implementation of it, so semantic recall returns exactly the set plain recall would.
- **Semantic ordering REORDERS; it does not filter.** An earlier version returned only the memories the index matched, so a just-written memory — no embedding yet — vanished from recall at every limit. Anything the index did not place is appended in declared order.
- **Relevance orders within groups, never across the supersession boundary.** Reordering by relevance alone puts a corrected-away fact above the correction that replaced it, which is the one thing supersession exists to prevent.

A missing index degrades *ordering*, never availability. "The vault knows nothing" is not an acceptable answer to a wiring problem.

### The write path

```mermaid
flowchart TB
    Call["remember — title, body,<br/>confidence, scope, projects"] --> Vault{"is the caller<br/>the vault itself?"}
    Vault -->|yes| Refuse["refused — a memory written here<br/>reaches only sessions that<br/>already read every note"]
    Vault -->|no| Neut["neutralise dangling wikilinks<br/>in title AND body"]
    Neut --> Val["validateMemory<br/>epistemic contract"]
    Val -->|fails| Report["refused, with reasons"]
    Val --> Dup{"near-duplicate?<br/>facet-gated"}
    Dup -->|"yes, and force is not set"| Collide["reports what it collided with,<br/>suggests supersedes"]
    Dup -->|no| Links["resolve links — emitted only if the target exists"]
    Links --> Write["claimFile: atomic exclusive create"]
    Write --> Sup["mark superseded memories,<br/>kept and back-linked"]
    Sup --> Idx["reindexSync"]
    Idx --> Done["Recorded: path, scope, warnings"]
```

**The vault does not write to its own memory layer.** A session inside the vault already reads every note directly, and a memory written there would be scoped to the vault-as-a-project — reaching only sessions that by definition did not need it. Write-only by construction, so it is refused rather than allowed to accumulate.

**The claim is atomic.** `writeMemory` originally used check-then-write. Six processes reporting success produced *four files* — silent loss, reproducible only across real processes, and one-server-per-repo is the actual deployment shape. It is now an exclusive create (`COPYFILE_EXCL`), guarded by a test that spawns real processes, since a single-threaded test serialises the calls and always passes.

**Re-indexing splits by what each step guarantees:**

```mermaid
flowchart LR
    W["a memory is written"] --> U["qmd update<br/>SYNCHRONOUS, bounded at 20s"]
    U -->|"failed"| Warn["the response says so —<br/>reporting success would be<br/>a lie the caller cannot detect"]
    U -->|"ok"| E["qmd embed<br/>DETACHED, unawaited"]
    E --> R["ranking improves<br/>moments later"]
```

`update` decides whether the note is retrievable at all, so it is synchronous. `embed` only decides where it *ranks*, and recall appends everything the index did not match in declared order — so waiting on a local model run for ordering that corrects itself moments later buys nothing. Measured, it was most of the write.

The vault normally re-indexes from a PostToolUse hook, but an MCP write is not a Claude Code tool call, so **no hook fires**. Without this step a note sits on disk and cannot be found, which is worse than no note because it looks like the system worked.

**`record_work` is the sibling tool, and the two are constantly confused.** The distinction is single-valued vs multi-valued: a work record is about one project at one moment, so it has a correct folder and gets filed into it. Routing is *delegated* to the calling session — which already carries the vault's conventions and can search to see where similar notes live — and the server's job is to validate, never to guess. A caller-supplied folder must resolve inside a declared root, with containment checked against **that root** rather than merely the vault: `brain/../work` passes a first-segment check and still resolves inside the vault, which is how a capture once landed in a folder nobody named.

### Failure modes, and how each is made visible

Every failure in this layer presents identically as **"no results"**. That is what `health` exists for.

| failure | how it presents | what surfaces it |
|---|---|---|
| memory root renamed in Obsidian | recall returns nothing | `health` reports the discovered root and the drift |
| captures split across two roots | recall sees only one | `health` warns, naming both |
| qmd index belongs to another vault | search returns nothing | `health` checks index ownership |
| qmd not installed | search degrades to lexical | `health` reports the launcher missing |
| `OM_VAULT_PATH` points elsewhere | *everything* describes the wrong vault | `health` warns when it disagrees with the launcher location |
| caller unidentified | only general memories visible | `recall` says so in prose; `health` says ANONYMOUS |
| memory scoped away | absent from recall | `recall` with `explain: true` gives counts and reasons |
| two repos sharing a folder name | each sees the other's memories | `health` reports the identity source and suggests `.om-project` |

A stray `VAULT_PATH` was honoured at one point, and that name is too generic to claim — it is set for unrelated reasons on real machines, and the result was a server serving a *different* vault while reporting that vault's config as if correct. Only `OM_VAULT_PATH` is read now.

### The install is two steps, and both are required

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

That goes in the **consuming project's** `.mcp.json`. Then add a short section to that project's own `CLAUDE.md` telling it the vault exists and to consult it.

Step 2 is not documentation garnish. Measured: with the server wired and no repo-side instruction, a session made **zero** vault calls and implemented a design the vault had recorded as explicitly rejected. With the instruction present, it refused and cited the note. This follows directly from the prohibition/routing asymmetry above — and it makes the repo-side snippet a shipped deliverable, since a server installed without it is a server that gets ignored.

> **Do not register the raw `qmd` server in a consuming repo.** It searches every note directly, with no notion of which memories were written for which project, so the repo matches against lessons meant for unrelated ones. Applying declared scope on top of the index is exactly what `om` adds, and going around it returns the **wrong** things, not merely more of them.

---

## Multi-Agent Portability

The same scripts serve three agents. Each agent has its own config file mapping its own event names to the shared scripts. The event vocabularies differ — Claude Code calls it `Stop`, Gemini calls it `SessionEnd`, Codex has no compaction event — but the scripts are identical.

```mermaid
flowchart TB
    subgraph Configs["Per-agent config (event name mapping)"]
        Claude[".claude/settings.json<br/>Claude Code"]
        Codex[".codex/hooks.json<br/>Codex CLI"]
        Gemini[".gemini/settings.json<br/>Gemini CLI"]
    end
    subgraph Shared[".claude/scripts/ (shared core)"]
        S1["session-start.ts"]
        S2["classify-message.ts"]
        S3["validate-write.ts"]
        S5["pre-compact.ts"]
        S6["stop-checklist.ts"]
        S7["qmd-refresh-run.ts<br/>(detached worker, not a hook)"]
    end
    subgraph Manuals["Operating manuals"]
        CM["CLAUDE.md"]
        AM["AGENTS.md"]
        GM["GEMINI.md"]
    end

    Claude --> Shared
    Codex --> Shared
    Gemini --> Shared
    Claude -.reads.-> CM
    Codex -.reads.-> AM
    Gemini -.reads.-> GM
```

Commands in `.claude/commands/` are plain Markdown prompts. Claude Code invokes them as slash commands. Codex and Gemini treat them as regular prompts (users type `om-standup` without the leading slash). No SDK binding is required.

Adding a fourth agent means writing one more config file and, ideally, one more operating manual if the agent reads context files natively.

The `om` server sits outside this table on purpose. It speaks MCP over stdio and knows nothing about which harness is on the other end, so it needs no per-agent config at all — any MCP-capable client registers it the same way.

---

## Vault-First Memory

There are two memory systems, and the distinction is load-bearing:

```mermaid
flowchart LR
    SessionStart["SessionStart hook<br/>(.claude/scripts/session-start.ts)"]
    subgraph Ephemeral["~/.claude/ (not git-tracked)"]
        MemIndex["MEMORY.md<br/>(auto-loaded index)"]
    end
    subgraph Durable["Vault (git-tracked)"]
        NorthStar["brain/North Star.md"]
        BrainIdx["brain/Memories.md<br/>(topic index)"]
        Gotchas["brain/Gotchas.md"]
        Patterns["brain/Patterns.md"]
        Decisions["brain/Key Decisions.md"]
    end

    SessionStart ==>|reads every session| NorthStar
    MemIndex -->|points at| BrainIdx
    MemIndex -->|points at| Gotchas
    MemIndex -->|points at| Patterns
    MemIndex -->|points at| Decisions
    BrainIdx --> Gotchas
    BrainIdx --> Patterns
    BrainIdx --> Decisions
```

Two load paths into a session, both landing in the vault:

- **Pointer indirection** — `~/.claude/.../MEMORY.md` is Claude Code's private auto-memory directory. The template uses it only to hold a thin index that points at vault locations. Topics fire on demand when the conversation touches them.
- **Direct injection** — `brain/North Star.md` is loaded by the `SessionStart` hook on every session as its own context block. It's the goals document; it needs to be present every time, not only when triggered.

All actual memory content lives in `brain/` as real Obsidian notes — queryable by QMD, visible in the graph, and shared across every agent (Claude Code, Codex, Gemini) because they all read the same vault.

The rule that enforces this: "when asked to remember, write to the relevant `brain/` topic note, not to `~/.claude/`." It is restated in `CLAUDE.md` because it is the easiest rule to break and the hardest to detect breaking.

### Two stores, one vault

`brain/` and `memories/` look similar and answer different questions. Keeping them apart is deliberate.

| | `brain/` | `memories/` |
|---|---|---|
| written by | a session **inside** the vault, or you | a session in **another repo**, through `om` |
| shape | curated topic notes, edited over time | append-only atomic entries under `YYYY/MM/` |
| reach | the whole vault, always | declared per entry — `scope`, `projects[]`, `platforms[]` |
| corrections | edit the note | a new entry that `supersedes` the old, which is kept and back-linked |
| browsing | the note itself, and the graph | `bases/Memories.base` — Recent, By project, Needs review, Superseded, General reach |
| served as an MCP resource | yes, if inside an exposed root | **never** — reach is per caller, so the note surface would bypass it |

Both are Markdown in the vault, both are in the graph, both are git-tracked. The difference is that a `brain/` note is a *document you maintain*, while a memory is an *immutable claim with a declared audience and a confidence level*.

The third store is `~/.claude/.../MEMORY.md`, which holds no content at all — only pointers. The template creates nothing else there, and `validate-write.ts` blocks attempts to.

---

## Skills and Commands

The template ships two categories of skills:

- **Obsidian-native skills** (`kepano/obsidian-skills`) in `.claude/skills/` — teach the agent Obsidian-flavored Markdown, the Obsidian CLI, Bases, and JSON Canvas. Loaded automatically when relevant.
- **A custom QMD skill** in `.claude/skills/qmd/` — teaches the agent the preference order for vault retrieval (MCP tools when registered → `qmd` CLI as fallback → Grep/Glob as last resort) and the signals that should trigger a proactive search (past decisions, incidents, people, architecture, duplicates before creating a note).

Slash commands in `.claude/commands/` are operational workflows (e.g. `/om-standup`, `/om-wrap-up`, `/om-review-brief`). Each is a Markdown file with prompt instructions. Subagents in `.claude/agents/` are invoked by those commands to keep heavy operations (Slack archaeology, PR deep scans, vault migration) out of the main context window.

The rule for adding a new command: if it produces durable knowledge, it should write to the vault. If it would only make sense within one session, it is probably better as a prompt pattern than a command.

---

## Extension Seams

The design makes these changes easy:

| Change | Touch this |
|--------|------------|
| Add a new note type | `vault-manifest.json` → `frontmatter_required`, and a template in `templates/` |
| Isolate this vault from others on the same machine | automatic (folder-derived); override with `vault-manifest.json` → `qmd_index`, then re-bootstrap |
| Add a new classification category | `.claude/scripts/classify-message.ts` + `CLAUDE.md` routing rules |
| Add a new lifecycle behavior | A new script in `.claude/scripts/` wired into all three agent configs |
| Add a new agent (Cursor, Windsurf, …) | New config file mapping events to existing scripts, optionally a new operating manual |
| Add a new subagent | A new Markdown file in `.claude/agents/`, referenced from the command that invokes it |
| Add a new Base view | A new `.base` file in `bases/`, embedded from `Home.md` if it should surface |
| Change which notes `om` serves | `vault-manifest.json` → `mcp_exposed_roots` / `mcp_never_expose`, or tag a note `private` |
| Move the memory store | Rename the folder in Obsidian — discovery finds it and `health` reports the drift; pin it with `memory_root` to be explicit |
| Add a new `om` tool | A declaration in `.claude/scripts/lib/mcp-tools.ts` + a case in `mcp-server.ts` — the description is what the model reads when deciding to call it |
| Change what the eager layer may spend | `vault-manifest.json` → `eager_layer_budget_bytes`, `listing_collapse_threshold` |

The design is hostile to these changes (on purpose):

- Storing memories outside the vault. The whole point of `brain/` and `memories/` is portability and graph visibility.
- Bypassing the manifest. If a new component needs to know the index name, the memory root, or the infrastructure boundary, it should read the manifest rather than hardcode.
- Hardcoding agent event names inside scripts. Event name translation is a config-layer concern.
- **Scoping vault notes per calling repo.** An earlier revision did this — a repo saw only its own notes — and it killed the most valuable measured capability, because the answers worth having come from *connecting* projects. Memories declare their reach; notes do not.
- **Adding a second read path.** Any new surface that answers "which notes exist" must resolve through `visibleFiles` rather than walking the vault itself.

---

## Upgrade Path

Template versions are tracked in `vault-manifest.json` with fingerprints that let `/om-vault-upgrade` detect an older vault's version by presence or absence of specific files. The migrator uses the infrastructure/user-content split to decide what to overwrite versus preserve. `CHANGELOG.md` documents what changed in each version.

The long-term stability guarantee is narrow: the manifest keys (`qmd_index`, `infrastructure`, `user_content_roots`, `frontmatter_required`, `memory_root`), the hook script names under `.claude/scripts/`, the `om-mcp.mjs` launcher path that consuming repos put in their `.mcp.json`, and the folder layout for user content. Everything else — including command names, subagent internals, and classification logic — is allowed to evolve between versions.

`memories/` is listed in `user_content_roots`, so an upgrade preserves it rather than treating it as template infrastructure. The launcher path is on this list because it is the one string that lives *outside* the vault, written into other repositories' config — moving it silently breaks every consumer.

## Install Paths

Two ways to bring obsidian-mind into a new directory:

**`git clone` — the original.** Clone the repo, open the folder in Obsidian, talk to the agent. Zero machinery beyond git. Every file ships verbatim; no install-time substitution. The hook scripts under `.claude/scripts/` only run when the agent triggers them. This path is the long-standing default and the one new contributors use to read the codebase.

**`shardmind install` — v6.** [ShardMind](https://github.com/breferrari/shardmind) is a package manager for Obsidian vault templates that produces the same vault as `git clone` plus a `.shardmind/` sidecar. A wizard collects four values (`user_name`, `org_name`, `vault_purpose`, `qmd_enabled`), gates eleven modules (4 always-on content, 4 removable content, 3 agent — `claude` / `codex` / `gemini`), and runs the lifecycle hooks: `bootstrap` (`.shardmind/hooks/bootstrap.ts`) initializes git and optionally bootstraps QMD when enabled, and `personalize` (`.shardmind/hooks/personalize.ts`) writes the user's name into `brain/North Star.md`. The shard contract is locked by three invariants:

1. **Invariant 1 — clone-equivalence under defaults.** `shardmind install --defaults` produces a vault byte-equivalent to `git clone` modulo Tier 1 exclusions (`.git`, `.github`, ephemeral `.obsidian/workspace*.json`), the engine metadata under `.shardmind/`, and a vault-root `shard-values.yaml`.
2. **Invariant 2 — hooks no-op on defaults.** Managed-file edits (e.g., the North Star personalization) live in the `personalize` hook, which the engine refuses to call when every value is at its default — so the invariant is engine-enforced, not hook-checked. With every value at its default, the install remains byte-equivalent to clone.
3. **Invariant 3 — post-update is additive-only.** The post-update hook restricts managed-file writes to `ctx.newFiles` (paths added by the new version), preventing clobbers of the merge engine's three-way resolution of user edits.

The contract surface lives at `.shardmind/shard.yaml` (manifest), `.shardmind/shard-schema.yaml` (values + module declarations), `.shardmind/hooks/{bootstrap,personalize,post-update}.ts` (lifecycle), and `.shardmindignore` at repo root (excludes `CONTRIBUTING.md`, README translations, marketing media from the install). Spec: [ShardMind `docs/SHARD-LAYOUT.md`](https://github.com/breferrari/shardmind/blob/main/docs/SHARD-LAYOUT.md).

**Additive principle.** `shardmind install` produces a strictly larger vault than `git clone` — never smaller, never different on shared paths under defaults. Deleting `.shardmind/` and `shard-values.yaml` from an installed vault leaves a working clone-equivalent vault. The same is true on the source side: deleting `.shardmind/` from this repo would produce a v5.1-shape working vault. ShardMind extends the clone experience; it doesn't replace it.

`shardmind update` (v6+) three-way-merges your edits with upstream changes — the moat that `git pull` doesn't provide for templates with installed-time personalization. `/om-vault-upgrade` remains the path for migrating a v5.x clone or arbitrary vault into v6 in place; once installed, `shardmind update` (or `shardmind adopt` for retroactive adoption) takes over.
