---
name: qmd
description: "Search the vault using QMD semantic search. Use PROACTIVELY before reading files directly — whenever the user asks about past decisions, incidents, people, meetings, architecture, patterns, or any vault content. Always prefer QMD over Grep/Glob for vault queries. Also use after creating/editing notes to check for duplicates and related content."
---

# QMD — Vault Semantic Search

Before reading vault files directly, search with QMD first. It returns relevant snippets without burning context on full file reads.

## Named Index (This Vault)

This vault declares a **named QMD index** in `vault-manifest.json` under `qmd_index`. Every QMD command in this document uses `--index <name>` so queries, updates, and context strings stay scoped to this vault — not blended with any other vault that shares the machine.

The MCP server (`.mcp.json`) and the SessionStart hook read the same field, so all three surfaces (CLI, MCP, hook) point at the same SQLite store.

**Read the index name from the manifest** before running commands:

```bash
INDEX=$(node -e "console.log(JSON.parse(require('fs').readFileSync('vault-manifest.json','utf8')).qmd_index)")
qmd --index "$INDEX" query "..."
```

In-session, substitute the value of `qmd_index` directly in your commands (the index name is stable across the vault's lifetime).

## Commands

### Search (pick one per query)
- `qmd --index <name> query "..." --json -n 10` — Best quality. Hybrid BM25 + vector + LLM reranking. Use for complex or conceptual queries.
- `qmd --index <name> search "..." --json -n 10` — Fast BM25 keyword. Use for exact terms, names, ticket numbers, dates.
- `qmd --index <name> vsearch "..." --json -n 5` — Semantic only. Use for exploratory queries where you don't know the exact words.

### Retrieve
- `qmd --index <name> get "path/to/file.md"` — Full document by path.
- `qmd --index <name> get "#docid"` — Full document by ID (from search results).
- `qmd --index <name> multi-get "org/people/*.md" --json -l 40` — Batch retrieve by glob pattern.

### Index Management
- `qmd --index <name> update` — Re-index after file changes (fast, ~1-2s incremental). The SessionStart hook runs this automatically.
- `qmd --index <name> embed` — Regenerate vector embeddings (slower, run after bulk changes).

## Bootstrap (Fresh Clone)

The QMD SQLite store lives outside the repo (`~/.cache/qmd/<index>.sqlite`), so a fresh clone starts with no index. Run the bootstrap once:

```bash
node --experimental-strip-types scripts/qmd-bootstrap.ts
```

It reads `qmd_index` and `qmd_context` from `vault-manifest.json`, registers the collection, attaches the vault context, walks the vault, and generates embeddings. Idempotent — safe to re-run.

## When to Search
- User mentions a past decision, incident, person, project → `qmd --index <name> query`
- User asks "what did we decide about X" → `qmd --index <name> query`
- User mentions a person by name → `qmd --index <name> search "<name>"`
- Before creating a new note → `qmd --index <name> vsearch "<topic>"` to check for existing content
- After creating a note → `qmd --index <name> vsearch "<note title>"` to find notes that should link to it
- Loading context for review prep → `qmd --index <name> multi-get "perf/evidence/*.md"`
- Loading 1-on-1 context → `qmd --index <name> search "<person name> 1-1"`

## After Bulk Changes
Run `qmd --index <name> update && qmd --index <name> embed` to keep the index fresh. The SessionStart hook does `qmd --index <name> update` automatically, but `qmd --index <name> embed` should be run explicitly after sessions that create many notes.

## MCP Server

`.mcp.json` wires QMD as an MCP server via `.claude/scripts/qmd-mcp.mjs` — a Node wrapper that bypasses the Windows npm shim and scopes the server to the same `qmd_index`. The `qmd` tools (`query`, `search`, `vsearch`, `get`, `multi-get`) appear in the Claude Code tool menu when QMD is installed. No per-query `--index` argument needed through the MCP — it's already scoped by the wrapper.
