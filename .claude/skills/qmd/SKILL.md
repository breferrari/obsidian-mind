---
name: qmd
description: "Search the vault using QMD semantic search. Use PROACTIVELY before reading files. Preference order: (1) MCP tools — mcp__qmd__query, mcp__qmd__get, mcp__qmd__multi_get, mcp__qmd__status — if they appear in your tool menu, use them first; (2) CLI `qmd --index <name> ...` as fallback; (3) Grep/Glob only when QMD is not installed. Trigger proactively for past decisions, incidents, people, meetings, architecture, patterns, or any vault content — and after creating/editing notes to check for duplicates and related content."
---

# QMD — Vault Semantic Search

Before reading vault files directly, search with QMD first. It returns relevant snippets without burning context on full file reads.

## Tool Surfaces — Preference Order

Pick the highest surface available and stop. All three read the same SQLite store (scoped by `qmd_index` in `vault-manifest.json`), so they return the same results; the choice is about interface ergonomics and context cost.

1. **MCP tools (preferred when registered)** — `mcp__qmd__query`, `mcp__qmd__get`, `mcp__qmd__multi_get`, `mcp__qmd__status`. If these appear in your tool menu, the MCP server is live and pre-scoped to this vault. Call them directly — no `--index` argument needed, no shell involved, typed arguments. This is the intended path during a session.
2. **CLI fallback** — `qmd --index <name> query|search|vsearch|get|multi-get`. Use when the MCP server isn't registered (older vault clones, Windows install drift, disabled in `.mcp.json`), or for one-off shell checks outside a session. Always pass `--index <name>`.
3. **Grep / Glob / Read** — last resort, only when QMD is not installed at all. These burn context on full file reads and don't rank by relevance.

Never fall through surfaces without cause — if MCP is registered, calling the CLI in a Bash tool is just a slower path to the same result.

## Named Index (This Vault)

This vault declares a **named QMD index** in `vault-manifest.json` under `qmd_index`. Every QMD command in this document uses `--index <name>` so queries, updates, and context strings stay scoped to this vault — not blended with any other vault that shares the machine.

The MCP server (`.mcp.json`) and the SessionStart hook read the same field, so all three surfaces (CLI, MCP, hook) point at the same SQLite store.

**Read the index name from the manifest** before running commands. This snippet prints a clear error when the field is missing instead of silently running `qmd --index undefined`:

```bash
INDEX=$(node -e '
  const m = JSON.parse(require("fs").readFileSync("vault-manifest.json", "utf8"));
  if (!m.qmd_index) { process.stderr.write("qmd_index not set in vault-manifest.json\n"); process.exit(1); }
  process.stdout.write(m.qmd_index);
') || exit 1
qmd --index "$INDEX" query "..."
```

In-session, substitute the value of `qmd_index` directly in your commands (the index name is stable across the vault's lifetime). The default in a fresh template is `obsidian-mind`.

## Commands

Each operation lists the MCP call first, then the CLI equivalent. Prefer MCP when available.

### Search (pick one per query)
- **Hybrid (best quality)** — `mcp__qmd__query` with `searches=[{type:"lex", query:"..."}, {type:"vec", query:"..."}]` and an `intent` arg. CLI: `qmd --index <name> query "..." --json -n 10`. Use for complex or conceptual queries.
- **Keyword (fast BM25)** — `mcp__qmd__query` with `searches=[{type:"lex", query:"..."}]`. CLI: `qmd --index <name> search "..." --json -n 10`. Use for exact terms, names, ticket numbers, dates.
- **Semantic only** — `mcp__qmd__query` with `searches=[{type:"vec", query:"..."}]`. CLI: `qmd --index <name> vsearch "..." --json -n 5`. Use for exploratory queries where you don't know the exact words.

### Retrieve
- **By path** — `mcp__qmd__get` with `path` arg. CLI: `qmd --index <name> get "path/to/file.md"`.
- **By docid** — `mcp__qmd__get` with `#abc123` syntax. CLI: `qmd --index <name> get "#docid"`.
- **Batch by glob** — `mcp__qmd__multi_get` with `pattern` arg. CLI: `qmd --index <name> multi-get "org/people/*.md" --json -l 40`.

### Index Management (CLI only — MCP exposes read surfaces)
- `qmd --index <name> update` — Re-index after file changes (fast, ~1-2s incremental). The SessionStart hook and the PostToolUse debounced refresh both run this automatically; manual invocation is rarely needed.
- `qmd --index <name> embed` — Regenerate vector embeddings (slower, run after bulk changes).

## Bootstrap (Fresh Clone)

The QMD SQLite store lives outside the repo (`~/.cache/qmd/<index>.sqlite`), so a fresh clone starts with no index. Run the bootstrap once:

```bash
node --experimental-strip-types scripts/qmd-bootstrap.ts
```

It reads `qmd_index` and `qmd_context` from `vault-manifest.json`, registers the collection, attaches the vault context, walks the vault, and generates embeddings. Idempotent — safe to re-run.

## When to Search

Each case lists the preferred MCP call; fall back to the CLI equivalent if MCP isn't registered.

- User mentions a past decision, incident, person, project → `mcp__qmd__query` (hybrid).
- User asks "what did we decide about X" → `mcp__qmd__query` (hybrid with `intent` describing the decision context).
- User mentions a person by name → `mcp__qmd__query` with `searches=[{type:"lex", query:"<name>"}]`.
- Before creating a new note → `mcp__qmd__query` with `searches=[{type:"vec", query:"<topic>"}]` to check for existing content.
- After creating a note → `mcp__qmd__query` with `searches=[{type:"vec", query:"<note title>"}]` to find notes that should link to it.
- Loading context for review prep → `mcp__qmd__multi_get` with `pattern="perf/evidence/*.md"`.
- Loading 1-on-1 context → `mcp__qmd__query` with `searches=[{type:"lex", query:"<person name> 1-1"}]`.

## After Bulk Changes
Run `qmd --index <name> update && qmd --index <name> embed` in the shell. The SessionStart hook and the PostToolUse debounced refresh run `update` automatically, but `embed` should be run explicitly after sessions that create many notes.
