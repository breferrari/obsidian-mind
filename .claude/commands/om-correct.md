---
description: "Sweep a corrected fact through the vault — finds every note restating it, applies the correction at the single source, replaces restatements with links, and preserves notes that correctly record what was believed at the time."
---

# /om-correct

```
/om-correct "<the corrected fact, stated as it is now true>"
```

The acting half of Write-Correctness Law 2. Laws 1 and 2 already say a corrected fact must be swept out of every note restating it; this is the thing that does it.

Run it **at the moment of correction**, not on a schedule. `/om-vault-audit` is periodic, whole-vault and structural, and takes no argument. A sweep needs the corrected fact as input, because nothing in the vault can resolve two contradicting notes — nothing in it says which is true. Only the person making the correction knows, which is why the fact is an argument and not a discovery.

## Hard rails

- **A historical note is never edited.** Not carefully, not with a callout. It is reported and preserved. See the asymmetry below.
- **Never delete.** Restatements are replaced with a link to the source, not removed.
- **Never commit.** Leave the working tree for review.
- **No authoritative note, no edits.** If the single source cannot be identified, the pass reports and stops rather than guessing.

## 1. Find

Both arms, always. Neither alone is sufficient.

- **Semantic** — `qmd query "<the corrected fact>"` (index name from `vault-manifest.json`). This is the arm that finds the *paraphrase*: the same claim in someone else's words, with none of the same strings. That half is invisible to grep and indistinguishable from correct prose to every structural check, and it is the half most likely to survive a manual sweep, because the sweeper stops when grep goes quiet.
- **Literal** — grep the distinctive strings from the fact: version numbers, tool names, counts, identifiers. This is the arm that finds a bare `v8.3.2` that means nothing to an embedding.

## 2. Classify

This is the design. The search is the easy part.

| class | what it is | what happens |
|---|---|---|
| **AUTHORITATIVE** | the single-source note Law 1 designates | the correction is **applied** here, and only here |
| **RESTATEMENT** | a living note asserting the fact, which per Law 1 should be linking to the source instead | the assertion is **replaced with a link** — fixes today's stain and prevents the next |
| **HISTORICAL** | a note that correctly records what was believed *at the time* | **preserved**, and reported so the omission is visible |

`isHistoricalNote` in `.claude/scripts/lib/correction-sweep.ts` decides the third category, and its rules are pinned by tests. A note is historical if **any one** holds:

- it sits under a record directory (`archive/`, `1-1/`, `meetings/`, `thinking/`, `memories/`, `journal/`, `incidents/`)
- its filename carries a date, prefix **or** suffix — this vault's 1:1 convention is `<Person> YYYY-MM-DD.md`
- its frontmatter `status` is `superseded`, `archived`, `completed`, `deprecated` or `done`

A frontmatter `date:` is deliberately **not** a signal. Every note has one.

**Ask before assuming a note is a restatement.** Token overlap is blind. A note that mentions the same subject while making a different claim is not restating anything, and rewriting it is a silent content loss.

## 3. Apply, in one pass

Report what changed and what was deliberately preserved:

```
/om-correct "the qmd MCP surface exposes no lexical search tool"

  AUTHORITATIVE   reference/QMD.md:12            ← correction applied here
  RESTATEMENT     brain/Gotchas.md:47            → replaced with link
  RESTATEMENT     work/Search Quality.md:88      → replaced with link
  HISTORICAL      work/archive/2026/Intake.md    ✋ preserved — records what
                                                    was believed 2026-03-02

  2 fixed, 1 applied, 1 preserved.
```

A correction callout on top of a note whose body still says the wrong thing is **not** a correction. Law 2 rules that out in as many words: the body is what future sessions re-absorb.

## Why historical notes are untouchable

The two failure modes are not symmetric, and the whole design follows from that.

A **missed restatement** leaves a stale claim somewhere. Someone reads it, notices, and fixes it. Recoverable, and visible.

A **rewritten record** destroys a true thing. The note said what was believed on a date; afterwards it says something else, reads perfectly fine, and carries no trace that it ever said otherwise. Nothing detects it, and nothing recovers it.

Law 5 warns about this class directly: an attribution quarter differing from a creation date "is legitimate, not a bug to fix". A sweep enthusiastic about consistency is how that law gets violated at scale.

So when the classification is uncertain, the note is preserved and reported. Always.

## Delegation

For a sweep touching more than a handful of notes, invoke the `correction-sweep` agent so the many-note read runs in its own context window — the same pattern `/om-vault-audit` uses for `vault-librarian`. The agent returns a classified plan; the edits happen here, after you have read it.

## Related

- `/om-vault-audit` — structural health, periodic, whole-vault. Complementary: it checks shape, this checks truth.
- `/om-tidy` — acts on hygiene flags. Also structural.
- `CLAUDE.md` § Write-Correctness Laws — Laws 1, 2 and 5, which this implements.
