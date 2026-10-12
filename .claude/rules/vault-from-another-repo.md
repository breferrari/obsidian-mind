Shared section: Claude Code and Grok load it at session start; other agents read it when AGENTS.md points here.

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

**2. Add a short section to that project's own instruction file (`CLAUDE.md` or `AGENTS.md`)**, telling it the vault exists and to consult it.

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
