#!/usr/bin/env python3
"""Classify user messages and inject routing hints for Claude."""
import json
import sys
import re


def _any_word_match(pattern_words: list, text: str) -> bool:
    """Check if any phrase appears as a whole word/phrase in text.

    Uses word boundaries (\\b) which work correctly with Unicode in Python 3.
    For mixed CJK/Latin text, \\b matches at script transitions (e.g. between
    a CJK character and an ASCII character), so English keywords embedded in
    CJK sentences are still detected.
    """
    for phrase in pattern_words:
        if re.search(r'\b' + re.escape(phrase) + r'\b', text):
            return True
    return False


def classify(prompt: str) -> list:
    p = prompt.lower()
    signals = []

    if _any_word_match(["decided", "decision", "we chose", "agreed to", "let's go with", "the call is", "we're going with"], p):
        signals.append("DECISION detected — consider creating a Decision Record in work/active/ and logging in work/Index.md Decisions Log")

    if _any_word_match(["incident", "outage", "down", "pagerduty", "severity", "p0", "p1", "p2", "sev1", "sev2", "postmortem", "rca"], p):
        signals.append("INCIDENT detected — consider using /incident-capture or creating an incident note in work/incidents/")

    if _any_word_match(["1:1", "1-1", "1-on-1", "one on one", "1on1", "catch up with", "sync with"], p):
        signals.append("1:1 CONTENT detected — consider creating a 1-on-1 note in work/1-1/ and updating the person note in org/people/")

    if _any_word_match(["shipped", "launched", "completed", "achieved", "won", "promoted", "kudos", "shoutout", "great feedback", "recognized", "praised", "win"], p):
        signals.append("WIN detected — consider adding to perf/Brag Doc.md with a link to the evidence note")

    if _any_word_match(["architecture", "system design", "rfc", "tech spec", "trade-off", "design doc", "adr"], p):
        signals.append("ARCHITECTURE discussion — consider creating a reference note in reference/ or a decision record")

    if _any_word_match(["told me", "said that", "feedback from", "met with", "talked to", "spoke with", "mentioned that", "mentioned the", "mentioned a"], p):
        signals.append("PERSON CONTEXT detected — consider updating the relevant person note in org/people/ and linking from the conversation note")

    if _any_word_match(["project update", "sprint", "milestone", "shipped feature", "released", "deployed"], p):
        signals.append("PROJECT UPDATE detected — consider updating the active work note in work/active/ and checking if wins should go to brag doc")

    return signals


def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError, EOFError):
        sys.exit(0)

    prompt = input_data.get("prompt", "")
    if not isinstance(prompt, str) or not prompt:
        sys.exit(0)

    try:
        signals = classify(prompt)
    except Exception:
        sys.exit(0)

    if signals:
        hints = "\n".join(f"- {s}" for s in signals)
        output = {
            "hookSpecificOutput": {
                "additionalContext": (
                    "Content classification hints (act on these if the user's message contains relevant info):\n"
                    + hints
                    + "\n\nRemember: use proper templates, add [[wikilinks]], follow CLAUDE.md conventions."
                )
            }
        }
        json.dump(output, sys.stdout)
        sys.stdout.flush()

    sys.exit(0)

if __name__ == "__main__":
    main()
