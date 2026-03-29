# Incident Capture

Capture an incident from Slack channels, DMs, and threads into structured vault notes. Produces a complete incident work note with timeline, people, analysis, and brag doc entry.

## Usage

```
/incident-capture <slack-urls>
```

Provide one or more Slack URLs: incident channels, DM conversations, threads. The more context, the better.

## Subagents

This command orchestrates two subagents for heavy lifting:
- **`slack-archaeologist`** — reads all Slack sources, builds unified timeline with attribution
- **`people-profiler`** — bulk creates/updates person notes for everyone involved

Launch both in parallel when starting the capture.

## Workflow

### 1. Gather Raw Data

For each Slack URL provided:
- Read the full channel/DM/thread using `slack_read_channel` or `slack_read_thread`
- Read ALL sub-threads within the channel (check for "Thread: N replies" indicators)
- Note every timestamp, person, and message — nothing is too small
- Download and examine any shared images or files

### 2. Identify People

For every person who posted or was mentioned:
- Fetch their Slack profile (`slack_read_user_profile`)
- Check if they have a person note in `org/people/`
- Note their role, team, and title
- Track who did what (reported, investigated, fixed, confirmed, etc.)

### 3. Build the Timeline

Reconstruct a detailed timeline from all sources:
- Every message with exact timestamp (CET)
- Attribution: who said/did what
- Cross-reference between channels (same person posting in incident channel + DMs)
- Key moments: first report, incident declared, root cause identified, fix created, fix merged, resolution confirmed

### 4. Create the Work Note

Create `work/incidents/<Incident Name>.md` with:

```yaml
---
date: "YYYY-MM-DD"
quarter: QN-YYYY
description: "~150 chars"
project: <relevant project>
status: active
ticket: TICKET-XXXX
severity: high/medium/low
role: <your role>
tags:
  - work-note
  - incident
---
```

Sections:
- **Context** — what happened, what triggered it, who was involved
- **Root Cause** — technical explanation
- **Resolution** — fix PR(s), what changed
- **Timeline** — full detailed table with timestamps
- **Impact** — users affected, business impact
- **Involved Personnel** — with wikilinks to person notes
- **Notes** — key actions by the user, analysis
- **Analysis** — what this means strategically (pattern, visibility, competencies)
- **Related** — wikilinks to all related notes, competencies

### 5. Create/Update People Notes

For key people involved who don't have person notes:
- Create in `org/people/` with proper frontmatter (`date`, `title`, `description`, `team`, `tags: [person]`)
- Add to `org/People & Context.md`

For existing people notes:
- Add the incident as a Key Moment

### 6. Update Indexes

- `work/Index.md` — add to Incidents section
- `brain/Memories.md` — add incident summary to Recent Context
- `brain/Patterns.md` — if this reveals a recurring pattern
- `brain/Gotchas.md` — if this reveals a technical gotcha
- `perf/Brag Doc.md` — add to relevant quarter with competency links
- `perf/brag/QN YYYY.md` — add detailed brag entry

### 7. Prepare Incident Report Draft (if applicable)

If you are or may become the post-mortem manager:
- Check the post-mortem template at `reference/Incident Response Process.md`
- Create `work/incidents/TICKET-XXXX Post-Mortem Draft.md` following your org's post-mortem template
- Include: Executive Summary, Narrative Timeline (4-column), 5 Whys analysis, Action Items table

### 8. Offer Next Steps

After capturing, suggest:
- "Want me to prepare the incident ticket fields?" (Points of Time, Impact, RCA)
- "Want me to draft a message for the incident channel?"
- "Want me to create an FE/iOS root cause analysis document?"
- "Should I run `/vault-audit` to verify everything links properly?"

## Important

- **Read every message** — don't skim or summarize prematurely
- **Preserve exact timestamps** — incident timelines need precision
- **Attribute everything** — who said what, who did what
- **Cross-reference** — the same event may be described differently in DMs vs incident channel
- **Check Slack profiles** — roles and teams matter for the story
- **Be blameless in public docs** — use commit SHAs, not names, in shareable documents
- **Private analysis is honest** — the vault work note can include strategic analysis about credit, visibility, etc.
