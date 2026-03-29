# Generate Review Brief

Generate a performance review context transfer document from vault data. Supports manager version (PO-friendly) and peer version (project-focused).

## Usage

```
/review-brief <audience> [period]
```

Examples:
- `/review-brief manager "Q3 2024 + Q4 2024"`
- `/review-brief peers "Q3 2024 + Q4 2024"`

## Subagent

- **`review-prep`** — aggregates all evidence (brag doc, decisions, incidents, competencies, 1:1 feedback, PR scans) for the period

Launch the subagent first to gather raw material, then use its output to write the brief.

## Workflow

### 1. Gather Data

Read these vault sources:
- `perf/<cycle>/Review Brief.md` (or current private brief) — full context
- `perf/Brag Doc.md` — quarterly highlights
- `perf/brag/Q*.md` — quarterly detail notes for the period
- `perf/evidence/Your PRs - *.md` — PR data
- `work/*.md` — project notes for the period
- `perf/competencies/*.md` — competency definitions
- Previous review notes for baseline comparison

### 2. Generate Content

**For manager audience:**
- Frame for a non-technical audience — outcome language, not technical jargon
- Include: The Arc (narrative), Impact at a Glance (table), Impact Details (per project), Competency Highlights (with baselines), Documentation Trail
- Simplify technical terms for your audience's background
- No wikilinks — use plain text or markdown links to external resources
- Include all documentation, task tracker, repository, error tracking, and communication references

**For peer audience:**
- Can be more technical but still accessible (peers write reviews that go to manager)
- Organize by project (a common review tool structure)
- Include "Other things worth mentioning" for non-project work
- Casual tone — "jog your memory", "no pressure to cover everything"
- No competency section — that's for the manager

### 3. Create Files

- Markdown version in `perf/`
- HTML version with professional styling (blue theme, tables, responsive)
- PDF via Chrome headless: `--headless --no-pdf-header-footer --print-to-pdf`

### 4. Verify

- Check page breaks in PDF (render pages with pdftoppm)
- Ensure no content is cut mid-section
- Verify all links work
- Cross-check PR counts and dates against `reference/` data

## Important

- NEVER include: sensitive interpersonal details, 1:1 talking points, peer selection strategy, personal strategic notes in shared versions
- Always maintain a private version with full context
- When updating, update BOTH private + shared versions
- Manager version: no wikilinks, non-technical language, professional formatting
- Peer version: project-focused, accessible language
