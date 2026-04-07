---
description: "Voice-calibrated editing — makes Claude-drafted text sound like you wrote it, not like AI wrote it."
---

Edit a note to match your writing voice. This is voice calibration, not pattern removal — learn HOW you write, not just what to avoid.

## Usage

```
/humanize <file path or note name>
```

## Workflow

### 1. Load Voice Samples

Read 2-3 recent notes you actually wrote or heavily edited to calibrate voice:
- `brain/North Star.md` — how you write about yourself
- The most recent `work/1-1/*.md` note — natural conversational voice
- Any brain note with your authentic writing style

Extract voice fingerprint: sentence length, punctuation habits, how you open sections, how you qualify statements, ratio of direct-to-hedged language, use of dashes and fragments.

### 2. Read Target Note

Read the note specified in $ARGUMENTS (resolve as wikilink name or file path).

Detect context from frontmatter and folder:
- **`work/1-1/`** → conversational, direct, uses "I", okay to be informal
- **`perf/` review content** → corporate-confident but human, evidence-based, respect charcount
- **`work/incidents/`** → precise, factual, timeline-oriented, no filler
- **`brain/`** → terse shorthand, fragments okay
- **Default** → colleague-to-colleague, like explaining something in a 1:1

### 3. Edit In-Place

Rewrite the note's content to match your voice. Key principles:

**Voice rules (from samples):**
- Direct statements, not hedged ones ("This was stressful" not "This presented some challenges")
- Match your natural rhythm — fragments, dashes, whatever you actually use
- Observations should be sharp, not softened
- A concise 600-char section is better than a padded 950-char one

**Anti-patterns (kill these):**
- "Notably", "significantly", "demonstrates", "leveraged", "facilitated"
- "It's worth noting that..." — just note it
- "This showcases..." — just describe what happened
- Hedge stacking: "potentially", "arguably", "it could be said that"
- Empty transitions: "Moving forward", "In terms of", "With regard to"
- Passive voice where active is natural: "was identified" → "found"
- Bullet points that all start with the same word pattern
- Rhetorical questions followed by immediate answers

**Preserve untouched:**
- All YAML frontmatter (pass through unchanged)
- `[[wikilinks]]` and `[[link|aliases]]`
- `![[embeds]]`
- Callout blocks (`> [!type]`)
- Block IDs (`^block-id`)
- Code blocks
- Tables (content can be edited, structure preserved)
- Checkboxes and task items

### 4. Summarize Changes

Present a brief summary (NOT a full diff):
- **Tone shift**: what changed overall (e.g., "removed hedging, shortened sentences")
- **Key rewrites**: 2-3 examples of before/after for the most significant changes
- **Preserved**: confirm what was left untouched and why

Don't show unchanged sections. The user can run `git diff` for the full picture.

## Important

- This is NOT "remove AI words from a list." It's "make this sound like the same person who wrote the other notes in this vault."
- If the note is already well-written, say so and make minimal changes. Don't edit for the sake of editing.
- Respect the context — a peer review needs to stay professional even after humanizing. A 1:1 note can be loose.
- If charcount matters (review content in `perf/`), verify limits after editing with `.claude/scripts/charcount.sh`.

Content to edit:
$ARGUMENTS
