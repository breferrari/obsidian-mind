# Peer Review Writer

Write a peer review for a colleague on your company's review tool. Produces project feedback, principles, and performance summary — all within 1000-char limits, fact-checked against vault evidence.

## Usage

```
/om-review-peer <Name>
```

## Context: Review System

Adapt to your company's review system. Common patterns:

- **Peers give comments only** — typically no scores. Manager gives scores.
- **Calibration** may happen at a broader organizational level.
- **Common review fields**: per-project feedback, principles, Strengths, Areas of Development, Confidential Comment (manager-only). Check your tool's character limits.

## Workflow

### 1. Gather Evidence

Load in order:
1. Person note from `org/people/<Name>.md`
2. PR evidence from `perf/evidence/<Name> PRs - <cycle>.md` (run `/om-peer-scan` if missing)
3. Peer review notes from `work/active/` (any active review writing notes)
4. Any brag sheet or impact overview the person shared (user provides)
5. Relevant work notes (search vault for their name)
6. Slack context if available

### 2. Assess Visibility

For each submitted project, classify your evidence level:
- **Direct**: Worked together daily, first-hand observations
- **Reviewed**: Saw their PRs, reviewed some code, aware of the work
- **Informed**: From their brag sheet or shared documents, limited personal observation

Be explicit about this in the review text. Never overclaim visibility.

### 3. Draft

For each section, draft within your tool's character limit. Use `.claude/scripts/charcount.sh <file> "<section>" "" <limit>` to verify.

**Project feedback** (per project):
- Lead with your relationship to the work ("worked alongside daily" vs "less direct visibility")
- Describe what they did and why it matters — behaviors and decisions, not just deliverables
- Include one specific moment you personally observed if possible

**Principles** (your company's defined principles):
- Lead with first-hand evidence, supplement with brag sheet
- Each principle should have distinct evidence — don't repeat the same example
- Reference specific behaviors, not generic praise

**Strengths**:
- Synthesize the defining theme across all projects — what makes this person distinctive?
- One or two specific moments that illustrate the theme
- Keep it genuine — a concise honest assessment beats padded praise

**Areas of Development**:
- Must be genuinely distinct per person — not "be more visible" for everyone
- Frame constructively: "the opportunity is X" not "the weakness is X"
- Base it on something you actually observed, not a generic suggestion

**Confidential Comment** (optional):
- Say something the manager specifically needs to know that wouldn't go in the public sections
- This is NOT a repeat of Areas of Development
- Examples: level trajectory, context the manager lacks, a specific flag worth watching

### 4. Quality Checks

Run these before presenting the draft:

- [ ] All sections within your tool's character limit (use `charcount.sh <file> "<section>" "" <limit>`)
- [ ] No PR numbers (e.g., #21579) — describe what was done instead
- [ ] No line counts (e.g., +4,743/-3,362) — these look like an audit
- [ ] No "weekend work visible in timestamps" — don't track when people work
- [ ] Honest about visibility level per project
- [ ] No repetition of the same example across project + principles + summary
- [ ] Areas of Development is specific to THIS person, not generic
- [ ] Confidential adds value the manager doesn't get from public sections
- [ ] Tone sounds like a colleague writing from experience, not a data analysis

### 5. Fact-Check

Enter plan mode and verify every factual claim against vault sources:
- Dates, timelines, sequences
- Specific contributions attributed to the person
- Claims about "first," "only," or "every" — these are easy to get wrong
- Anything from their brag sheet that you present as your own observation — flag the source honestly

### 6. Save

Save draft to `thinking/<name>-peer-review.md` for copy-pasting.
After submission, promote to `perf/<cycle>/Peer Review - <Full Name>.md`.

## Tone Rules

- Write like a colleague talking about someone they work with
- Specific enough to be credible, casual enough to be human
- No emojis, no corporate buzzwords, no "synergy"
- If you wouldn't say it in a 1:1 conversation, don't write it
- It's OK for some sections to be 600 chars if that's all you need to say — don't pad
