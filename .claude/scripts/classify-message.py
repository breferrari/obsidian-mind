#!/usr/bin/env python3
"""Classify user messages and inject routing hints for Claude.

Architecture: data-driven signal matching. Each signal has a list of trigger
patterns checked via word-boundary regex. Words can appear in multiple signals
(explicit overlaps) because the cost of a false positive hint is ~0 (Claude
ignores irrelevant hints) while a false negative means missed routing.

Patterns include English, Japanese, Korean, and Simplified Chinese to support
multilingual users. The Latin-letter boundary regex handles all scripts.
"""
import json
import sys
import re


# Each signal: name, routing message, and trigger patterns.
# Patterns are checked with Latin-letter lookarounds — safe for CJK/Latin mixed text.
# Words MAY appear in multiple signals to express natural category overlaps.
SIGNALS = [
    {
        "name": "DECISION",
        "message": "DECISION detected — consider creating a Decision Record in work/active/ and logging in work/Index.md Decisions Log",
        "patterns": [
            # English
            "decided", "deciding", "decision", "we chose", "agreed to",
            "let's go with", "the call is", "we're going with",
            # Japanese
            "決定した", "決めた", "合意した",
            # Korean
            "결정했어", "결정했습니다", "합의했어",
            # Chinese
            "决定了", "我们决定", "确定了", "同意",
        ],
    },
    {
        "name": "INCIDENT",
        "message": "INCIDENT detected — consider using /incident-capture or creating an incident note in work/incidents/",
        "patterns": [
            # English
            "incident", "outage", "pagerduty", "severity",
            "p0", "p1", "p2", "sev1", "sev2", "postmortem", "rca",
            # Japanese
            "インシデント", "障害",
            # Korean
            "인시던트", "장애",
            # Chinese
            "事件", "故障", "事后分析",
        ],
    },
    {
        "name": "1:1 CONTENT",
        "message": "1:1 CONTENT detected — consider creating a 1-on-1 note in work/1-1/ and updating the person note in org/people/",
        "patterns": [
            # English
            "1:1", "1-1", "1-on-1", "one on one", "1on1",
            "catch up with", "sync with",
            # Japanese
            "ワンオンワン",
            # Korean
            "원온원",
            # Chinese
            "一对一", "单独面谈",
        ],
    },
    {
        "name": "WIN",
        "message": "WIN detected — consider adding to perf/Brag Doc.md with a link to the evidence note",
        "patterns": [
            # Delivery — English (shared with PROJECT UPDATE)
            "shipped", "shipping", "launched", "launching",
            "completed", "completing", "released", "releasing",
            "deployed", "deploying",
            # Achievement — English
            "achieved", "achieving", "won", "promoted", "praised", "win",
            "kudos", "shoutout", "great feedback", "recognized",
            # Japanese
            "出荷した", "リリースした", "達成した", "褒められた",
            # Korean
            "배포했어", "출시했어", "달성했어", "칭찬받았어",
            # Chinese
            "发布了", "上线了", "完成了", "表扬", "认可",
        ],
    },
    {
        "name": "ARCHITECTURE",
        "message": "ARCHITECTURE discussion — consider creating a reference note in reference/ or a decision record",
        "patterns": [
            # English
            "architecture", "system design", "rfc", "tech spec",
            "trade-off", "design doc", "adr",
            # Japanese
            "アーキテクチャ", "システム設計",
            # Korean
            "아키텍처", "시스템 설계",
            # Chinese
            "架构", "系统设计", "技术规范",
        ],
    },
    {
        "name": "PERSON CONTEXT",
        "message": "PERSON CONTEXT detected — consider updating the relevant person note in org/people/ and linking from the conversation note",
        "patterns": [
            # English
            "told me", "said that", "feedback from", "met with",
            "talked to", "spoke with",
            "mentioned that", "mentioned the", "mentioned a",
            # Japanese
            "言ってた", "フィードバック", "話した",
            # Korean
            "말했어", "피드백", "얘기했어", "언급했어",
            # Chinese
            "说了", "提到", "反馈", "提及",
        ],
    },
    {
        "name": "PROJECT UPDATE",
        "message": "PROJECT UPDATE detected — consider updating the active work note in work/active/ and checking if wins should go to brag doc",
        "patterns": [
            # English
            "project update", "sprint", "milestone",
            # Delivery — English (shared with WIN)
            "shipped", "shipping", "shipped feature",
            "launched", "launching", "completed", "completing",
            "released", "releasing", "deployed", "deploying",
            # Delivery-only — English (not wins on their own)
            "went live", "rolled out", "rolling out",
            "merged", "merging", "cut the release",
            # Japanese
            "スプリント", "マイルストーン", "マージした", "リリースしました",
            # Korean
            "스프린트", "마일스톤", "배포", "릴리스", "병합",
            # Chinese (发布了, 上线 shared with WIN)
            "迭代", "里程碑", "发布了", "上线", "合并了",
        ],
    },
]


def _any_word_match(pattern_words: list, text: str) -> bool:
    """Check if any phrase appears as a whole word/phrase in text.

    Uses Latin-letter boundaries instead of \\b. Python's \\b treats CJK
    characters as word characters (\\w), so \\bdecision\\b fails to match
    in "のdecisionについて" (no boundary between Hiragana and Latin).

    (?<![a-zA-Z]) and (?![a-zA-Z]) ensure English keywords aren't part of
    a larger English word, while allowing CJK adjacency.
    """
    for phrase in pattern_words:
        if re.search(r'(?<![a-zA-Z])' + re.escape(phrase) + r'(?![a-zA-Z])', text):
            return True
    return False


def classify(prompt: str) -> list:
    p = prompt.lower()
    signals = []
    for sig in SIGNALS:
        if _any_word_match(sig["patterns"], p):
            signals.append(sig["message"])
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
