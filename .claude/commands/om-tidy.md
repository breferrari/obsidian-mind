---
description: "Self-maintenance pass — acts on every hygiene flag: archives completed work, groups loose clusters, splits oversized notes, reports stale open loops, fixes links. Safe by construction: never deletes, never commits, zero content loss."
---

# /om-tidy

The acting half of the hygiene system. The SessionStart/Stop hooks and the PostToolUse write-time flags DETECT drift; this command ACTS on it. Run on demand, at wrap-up when flags are present, or when the flag list has visibly piled up.

## Hard rails (safe by construction)

- **Never delete.** Reorganization is `git mv` + splits with verbatim content moves. Zero content loss.
- **Never commit.** Git sync stays the user's call — leave the working tree for review.
- **Judgment calls get flagged, not executed.** Anything ambiguous (does this cluster share real context? is this note's status actually done?) is listed for the user instead of acted on.

## The mechanical tier (act on these)

Work through the current hygiene flags in order:

1. **Completed-not-archived** — `git mv` from `work/active/` to `work/archive/YYYY/`; clusters keep their folder (mirror the grouping); update `work/Index.md`. Same semantics as `/om-project-archive` — use it for anything with ceremony.
2. **Ungrouped clusters** — when the loose notes genuinely share context (judge, don't trust token overlap): create `work/active/<Topic>/`, `git mv` the members in.
3. **Oversized notes (25KB+)** — SPLIT, never trim: move whole sections verbatim into domain notes, event-log satellites, or an archive note; leave a one-liner index behind in the original; retarget links that pointed at the moved sections. `*Archive*` names are exempt by design. A split is complete only when the new notes are wired into the graph — search each new note's concepts (QMD when available) and link what surfaces.
4. **Index drift, orphans, broken links** — new notes must be linked from at least one note; fix wikilinks broken by any moves this pass made; update `work/Index.md` / `org/People & Context.md` / `perf/Brag Doc.md` as touched.
5. **Semantic-linking pass** — for notes created or split this pass, `qmd query` their core concepts (index name from `vault-manifest.json`) and add the links the graph is missing.
6. **Memory-inbox promotion (`memories/YYYY/MM/`)** — durable captures get copied into the right `brain/` topic note. **Promotion is ADDITIVE: copy, never move.** `recall` reaches `brain/` only *through* a capture, so deleting one removes the lesson from every repo that cannot read `brain/` at all — which is the whole audience it was written for.

   Then mark the capture so the flag can fall, and **anchor the marker**:

   ```yaml
   promoted: "brain/Gotchas - Engineering#^om-a1b2c3"
   ```

   Give the promoted block an Obsidian block id and point the marker at it. That anchor is what lets `recall` serve the *corrected* text to a foreign repo instead of the capture as first written — see `ARCHITECTURE.md`.

   Both placements Obsidian produces are accepted: **`^om-a1b2c3` at the end of the bullet or paragraph, preceded by a space**, or **alone on the line directly after it** (which is what Obsidian generates for tables and callouts). The space matters — `text^om-a1b2c3` does not resolve, and reports as a stale anchor rather than as a typo.

   A **heading** anchor (`#Some Section`) works where a block id is overkill. It matches case-insensitively with whitespace collapsed, and returns the section body *without* the heading line, up to the next heading of the same or higher level.

   Two limits worth knowing before you point at one. A **level-1** heading is refused — in this vault's shape the H1 is the note's own title, so `#Some Note` would address the whole note through an anchor that looks specific, and it reports as a stale anchor instead. And what an anchor serves is **capped**, at 40 lines or 8,000 characters, whichever bites first; the caller is told when it did. Point at an `##` or deeper, and at something that reads whole in well under a screenful.

   **The anchor is opt-in and deliberate.** A bare `promoted: brain/Note` still marks the capture and still clears the flag, but serves nothing — the caller is only told a corrected version exists and where. Two things to check before adding one:

   - **The block reads correctly on its own to someone outside this vault**, because that block, and nothing around it, is what they receive.
   - **The target note is one the server actually serves.** A note tagged `private`, one withheld by `mcp_never_expose`, or one outside the exposed roots refuses the anchor — the capture body is served instead and the caller is told why. Anchoring into such a note is not a leak, it is a no-op.

   Never edit a capture's body, `scope` or `confidence`. The marker is the one edit allowed.

## The report tier (list, never act)

- **Open loops** — the stale follow-up flags from the hygiene scan. Chasing, closing, or parking a follow-up is the user's judgment; list them with paths + counts and move on.
- **Competency evidence freshness** — for each `perf/competencies/*.md`, count inbound links from notes modified this half (grep/QMD backlinks + mtime). Competencies with ZERO fresh evidence this half get listed — months of lead time to generate the missing evidence beats discovering thinness at review season. Report only; what counts as evidence is review judgment.
- Any judgment calls deferred from the mechanical tier.

## Report

Write `thinking/YYYY-MM-DD-tidy-report.md`: actions taken (moves, splits, links), flags cleared, judgment calls deferred, open loops listed. Keep it compact — the report is a receipt, not an essay. Delete it once its findings are resolved (thinking/ is a scratchpad by contract).

## Headless subset

`node --experimental-strip-types .claude/scripts/tidy-fix.ts [--apply]` runs the DETERMINISTIC subset from cron with no agent: archives completed work, migrates misplaced memory files (copy → regenerate index → verify → remove), and refuses every judgment class with a pointer back here. Dry-run by default.

## Related

- `/om-weekly` § hygiene sweep — the scheduled home of this pass
- `/om-project-archive` · `/om-vault-audit` (deep audit, agent-backed)
