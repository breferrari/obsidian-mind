#!/usr/bin/env python3
"""Test suite for Claude Code hook scripts (classify-message.py, validate-write.py).

Run: python3 .claude/scripts/test_hooks.py
Verbose: python3 .claude/scripts/test_hooks.py -v

Stdlib only — no external dependencies. Uses unittest with subTest for
parameterized CJK tests.
"""
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

# ---------------------------------------------------------------------------
# Import hook modules (hyphenated filenames require importlib)
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

classify_mod = importlib.import_module("classify-message")
classify = classify_mod.classify
_any_word_match = classify_mod._any_word_match
SIGNALS = classify_mod.SIGNALS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def run_script(script_name, stdin_data=None):
    """Run a hook script via subprocess, matching how settings.json invokes it."""
    cmd = [sys.executable, os.path.join(SCRIPT_DIR, script_name)]
    stdin_str = json.dumps(stdin_data) if stdin_data is not None else ""
    proc = subprocess.run(
        cmd, input=stdin_str, capture_output=True, text=True, timeout=10
    )
    return proc.stdout, proc.stderr, proc.returncode


def get_signal_names(prompt):
    """Classify a prompt and return sorted list of signal names."""
    messages = classify(prompt)
    names = []
    for msg in messages:
        for sig in SIGNALS:
            if msg == sig["message"]:
                names.append(sig["name"])
                break
    return sorted(names)


# ---------------------------------------------------------------------------
# TestAnyWordMatch — unit tests for the core matching function
# ---------------------------------------------------------------------------
class TestAnyWordMatch(unittest.TestCase):
    def test_basic_match(self):
        self.assertTrue(_any_word_match(["hello"], "hello world"))

    def test_no_match(self):
        self.assertFalse(_any_word_match(["xyz"], "hello world"))

    def test_boundary_prevents_substring(self):
        """'decision' must not match inside 'predecisioned'."""
        self.assertFalse(_any_word_match(["decision"], "predecisioned"))

    def test_boundary_prevents_prefix(self):
        """'shipped' must not match inside 'unshipped'."""
        self.assertFalse(_any_word_match(["shipped"], "unshipped items"))

    def test_cjk_adjacency(self):
        """English keyword adjacent to CJK characters must match."""
        self.assertTrue(_any_word_match(["decision"], "のdecisionについて"))

    def test_multi_word_phrase(self):
        self.assertTrue(_any_word_match(["one on one"], "had a one on one with Alice"))

    def test_multi_word_no_partial(self):
        """'one on one' should not match 'one on two'."""
        self.assertFalse(_any_word_match(["one on one"], "one on two"))

    def test_cjk_pattern_match(self):
        """CJK patterns should match in CJK text."""
        self.assertTrue(_any_word_match(["決定した"], "チームで決定した"))

    def test_case_sensitivity(self):
        """_any_word_match is case-sensitive; classify() lowercases first."""
        self.assertFalse(_any_word_match(["decision"], "DECISION"))
        self.assertTrue(_any_word_match(["decision"], "decision"))


# ---------------------------------------------------------------------------
# TestClassifyEnglish — unit tests for English signal detection
# ---------------------------------------------------------------------------
class TestClassifyEnglish(unittest.TestCase):
    def test_decision(self):
        self.assertIn("DECISION", get_signal_names("we decided to use Redis"))

    def test_incident(self):
        self.assertIn("INCIDENT", get_signal_names("there was an outage in prod"))

    def test_1on1(self):
        self.assertIn("1:1 CONTENT", get_signal_names("had a 1:1 with my manager"))

    def test_1on1_hyphen(self):
        self.assertIn("1:1 CONTENT", get_signal_names("1-1 with Sarah today"))

    def test_win(self):
        self.assertIn("WIN", get_signal_names("got kudos from the team"))

    def test_architecture(self):
        self.assertIn("ARCHITECTURE", get_signal_names("wrote a tech spec for the API"))

    def test_person_context(self):
        self.assertIn("PERSON CONTEXT", get_signal_names("Alice told me about the deadline"))

    def test_project_update(self):
        self.assertIn("PROJECT UPDATE", get_signal_names("sprint planning for next week"))

    def test_overlap_shipped(self):
        names = get_signal_names("we shipped the feature")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_overlap_deployed(self):
        names = get_signal_names("deployed to production")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_multi_signal(self):
        names = get_signal_names("we decided to fix the incident")
        self.assertIn("DECISION", names)
        self.assertIn("INCIDENT", names)

    def test_case_insensitivity(self):
        self.assertIn("DECISION", get_signal_names("DECIDED to go with option A"))

    def test_return_type(self):
        result = classify("hello world")
        self.assertIsInstance(result, list)

    def test_return_items_are_strings(self):
        result = classify("we decided to ship it")
        for item in result:
            self.assertIsInstance(item, str)


# ---------------------------------------------------------------------------
# TestClassifyInflections — English verb form coverage
# ---------------------------------------------------------------------------
class TestClassifyInflections(unittest.TestCase):
    def test_deciding(self):
        self.assertIn("DECISION", get_signal_names("we're still deciding on the approach"))

    def test_deploying(self):
        names = get_signal_names("deploying the fix right now")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_shipping(self):
        names = get_signal_names("shipping the feature today")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_merging(self):
        self.assertIn("PROJECT UPDATE", get_signal_names("merging the PR this afternoon"))

    def test_launching(self):
        names = get_signal_names("launching the new service tomorrow")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_completing(self):
        names = get_signal_names("completing the migration this week")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_releasing(self):
        names = get_signal_names("releasing v2.0 on Friday")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_achieving(self):
        self.assertIn("WIN", get_signal_names("achieving the quarterly target"))

    def test_rolling_out(self):
        self.assertIn("PROJECT UPDATE", get_signal_names("rolling out the new config"))

    # Present-tense -s/-es forms
    def test_deploys(self):
        names = get_signal_names("she deploys to prod every Friday")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_launches(self):
        names = get_signal_names("he launches the service tomorrow")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_ships(self):
        names = get_signal_names("the team ships fast")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_merges(self):
        self.assertIn("PROJECT UPDATE", get_signal_names("she merges the PR"))

    def test_releases(self):
        names = get_signal_names("he releases a new version weekly")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_release_cut(self):
        self.assertIn("PROJECT UPDATE", get_signal_names("did the release cut for v3.4"))


# ---------------------------------------------------------------------------
# TestClassifyCJK — per-language signal detection with subTest
# ---------------------------------------------------------------------------
class TestClassifyCJK(unittest.TestCase):
    """Test native CJK patterns for each signal category."""

    CJK_CASES = {
        "DECISION": {
            "ja": ("チームで決定した", "決定した"),
            "ko": ("결정했습니다", "결정했습니다"),
            "zh": ("我们决定了这个方案", "决定了"),
        },
        "INCIDENT": {
            "ja": ("インシデントが発生しました", "インシデント"),
            "ko": ("장애가 발생했습니다", "장애"),
            "zh": ("发生了故障需要处理", "故障"),
        },
        "1:1 CONTENT": {
            "ja": ("マネージャーとワンオンワンした", "ワンオンワン"),
            "ko": ("원온원 미팅을 했습니다", "원온원"),
            "zh": ("今天有一对一会议", "一对一"),
        },
        "WIN": {
            "ja": ("新機能をリリースした", "リリースした"),
            "ko": ("서비스를 출시했어", "출시했어"),
            "zh": ("新版本发布了", "发布了"),
        },
        "ARCHITECTURE": {
            "ja": ("アーキテクチャの見直しが必要", "アーキテクチャ"),
            "ko": ("아키텍처 리뷰를 했습니다", "아키텍처"),
            "zh": ("系统架构需要重新设计", "架构"),
        },
        "PERSON CONTEXT": {
            "ja": ("田中さんが言ってた", "言ってた"),
            "ko": ("김 매니저가 말했어", "말했어"),
            "zh": ("他提到了这个问题", "提到"),
        },
        "PROJECT UPDATE": {
            "ja": ("今週のスプリントで完了する", "スプリント"),
            "ko": ("이번 스프린트에서 완료", "스프린트"),
            "zh": ("这个迭代的进展报告", "迭代"),
        },
    }

    def test_japanese_signals(self):
        for signal_name, langs in self.CJK_CASES.items():
            prompt, pattern = langs["ja"]
            with self.subTest(signal=signal_name, lang="ja", prompt=prompt):
                self.assertIn(signal_name, get_signal_names(prompt),
                              f"Japanese pattern '{pattern}' should trigger {signal_name}")

    def test_korean_signals(self):
        for signal_name, langs in self.CJK_CASES.items():
            prompt, pattern = langs["ko"]
            with self.subTest(signal=signal_name, lang="ko", prompt=prompt):
                self.assertIn(signal_name, get_signal_names(prompt),
                              f"Korean pattern '{pattern}' should trigger {signal_name}")

    def test_chinese_signals(self):
        for signal_name, langs in self.CJK_CASES.items():
            prompt, pattern = langs["zh"]
            with self.subTest(signal=signal_name, lang="zh", prompt=prompt):
                self.assertIn(signal_name, get_signal_names(prompt),
                              f"Chinese pattern '{pattern}' should trigger {signal_name}")

    def test_mixed_cjk_english_japanese(self):
        self.assertIn("DECISION", get_signal_names("のdecisionについて"))

    def test_mixed_cjk_english_chinese(self):
        self.assertIn("DECISION", get_signal_names("我们decided了"))

    def test_mixed_cjk_english_korean(self):
        self.assertIn("1:1 CONTENT", get_signal_names("오늘 1:1 미팅"))

    def test_cjk_overlap(self):
        """Chinese delivery word triggers both WIN and PROJECT UPDATE."""
        names = get_signal_names("新版本发布了")
        self.assertIn("WIN", names)
        self.assertIn("PROJECT UPDATE", names)

    def test_cjk_false_positive_japanese(self):
        self.assertEqual(get_signal_names("普通の会話です"), [])

    def test_cjk_false_positive_korean(self):
        self.assertEqual(get_signal_names("코드 리뷰를 합시다"), [])

    def test_cjk_false_positive_chinese(self):
        self.assertEqual(get_signal_names("今天天气不错"), [])


# ---------------------------------------------------------------------------
# TestClassifyFalsePositives — must NOT trigger signals
# ---------------------------------------------------------------------------
class TestClassifyFalsePositives(unittest.TestCase):
    NO_SIGNAL_CASES = [
        ("downloading the markdown file", "download ≠ any trigger"),
        ("hello world", "generic greeting"),
        ("just reading some code", "generic activity"),
        ("the function returns an error", "generic error"),
        ("I wonder about the implementation", "wonder ≠ won"),
        ("she is predecisioned on this", "predecisioned ≠ decision"),
        ("unshipped items in the backlog", "unshipped ≠ shipped"),
        ("acknowledged the problem", "no trigger words"),
    ]

    def test_no_false_positives(self):
        for prompt, reason in self.NO_SIGNAL_CASES:
            with self.subTest(prompt=prompt, reason=reason):
                self.assertEqual(get_signal_names(prompt), [],
                                 f"Should not trigger: {reason}")

    def test_empty_string(self):
        self.assertEqual(classify(""), [])


# ---------------------------------------------------------------------------
# TestClassifyIntegration — subprocess tests for full stdin→stdout pipeline
# ---------------------------------------------------------------------------
class TestClassifyIntegration(unittest.TestCase):
    SCRIPT = "classify-message.py"

    def test_valid_json_with_signal(self):
        stdout, _, rc = run_script(self.SCRIPT, {"prompt": "we decided to use React"})
        self.assertEqual(rc, 0)
        data = json.loads(stdout)
        self.assertIn("hookSpecificOutput", data)
        self.assertEqual(data["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertIn("DECISION", data["hookSpecificOutput"]["additionalContext"])

    def test_valid_json_no_signal(self):
        stdout, _, rc = run_script(self.SCRIPT, {"prompt": "hello world"})
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    def test_invalid_json(self):
        cmd = [sys.executable, os.path.join(SCRIPT_DIR, self.SCRIPT)]
        proc = subprocess.run(cmd, input="not json{{", capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0)

    def test_missing_prompt(self):
        _, _, rc = run_script(self.SCRIPT, {"foo": "bar"})
        self.assertEqual(rc, 0)

    def test_non_string_prompt(self):
        _, _, rc = run_script(self.SCRIPT, {"prompt": 123})
        self.assertEqual(rc, 0)

    def test_null_prompt(self):
        _, _, rc = run_script(self.SCRIPT, {"prompt": None})
        self.assertEqual(rc, 0)

    def test_empty_stdin(self):
        cmd = [sys.executable, os.path.join(SCRIPT_DIR, self.SCRIPT)]
        proc = subprocess.run(cmd, input="", capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0)

    def test_empty_prompt(self):
        _, _, rc = run_script(self.SCRIPT, {"prompt": ""})
        self.assertEqual(rc, 0)


# ---------------------------------------------------------------------------
# TestValidateWriteIntegration — subprocess tests for validate-write.py
# ---------------------------------------------------------------------------
class TestValidateWriteIntegration(unittest.TestCase):
    SCRIPT = "validate-write.py"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_md(self, content, name="test.md"):
        path = os.path.join(self.tmpdir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def _run(self, file_path):
        return run_script(self.SCRIPT, {"tool_input": {"file_path": file_path}})

    # -- Skip rules --

    def test_skip_non_markdown(self):
        stdout, _, rc = self._run("/tmp/test.txt")
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    def test_skip_readme(self):
        stdout, _, rc = self._run("/some/path/README.md")
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    def test_skip_translated_readmes(self):
        for lang in ["ja", "ko", "zh-CN"]:
            with self.subTest(lang=lang):
                stdout, _, rc = self._run(f"/some/path/README.{lang}.md")
                self.assertEqual(rc, 0)
                self.assertEqual(stdout.strip(), "")

    def test_skip_changelog(self):
        stdout, _, rc = self._run("/some/path/CHANGELOG.md")
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    def test_skip_claude_dir(self):
        stdout, _, rc = self._run("/vault/.claude/commands/foo.md")
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    def test_skip_templates(self):
        stdout, _, rc = self._run("/vault/templates/Work Note.md")
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    def test_skip_thinking(self):
        stdout, _, rc = self._run("/vault/thinking/draft.md")
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    def test_skip_windows_path(self):
        """Backslash paths with .claude\\ should be skipped after normalization."""
        stdout, _, rc = self._run("C:\\vault\\.claude\\commands\\foo.md")
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    # -- Frontmatter validation --

    def test_missing_frontmatter(self):
        path = self._make_md("No frontmatter here\n" + "x" * 300)
        stdout, _, rc = self._run(path)
        self.assertEqual(rc, 0)
        data = json.loads(stdout)
        self.assertEqual(data["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        self.assertIn("Missing YAML frontmatter", data["hookSpecificOutput"]["additionalContext"])

    def test_missing_tags(self):
        path = self._make_md("---\ndate: 2026-04-05\ndescription: test\n---\n# Note\n" + "[[Link]] " + "x" * 300)
        stdout, _, rc = self._run(path)
        self.assertEqual(rc, 0)
        self.assertIn("Missing `tags`", stdout)

    def test_missing_description(self):
        path = self._make_md("---\ndate: 2026-04-05\ntags:\n  - test\n---\n# Note\n" + "[[Link]] " + "x" * 300)
        stdout, _, rc = self._run(path)
        self.assertEqual(rc, 0)
        self.assertIn("Missing `description`", stdout)

    def test_missing_date(self):
        path = self._make_md("---\ndescription: test\ntags:\n  - test\n---\n# Note\n" + "[[Link]] " + "x" * 300)
        stdout, _, rc = self._run(path)
        self.assertEqual(rc, 0)
        self.assertIn("Missing `date`", stdout)

    # -- Wikilink validation --

    def test_no_wikilinks_long_note(self):
        path = self._make_md("---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\n# Note\n" + "x" * 300)
        stdout, _, rc = self._run(path)
        self.assertEqual(rc, 0)
        self.assertIn("No [[wikilinks]]", stdout)

    def test_short_note_no_wikilink_ok(self):
        path = self._make_md("---\ndate: 2026-04-05\ndescription: test\ntags:\n  - test\n---\nShort note.")
        stdout, _, rc = self._run(path)
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    # -- Valid note --

    def test_valid_note_no_warnings(self):
        path = self._make_md(
            "---\ndate: 2026-04-05\ndescription: A valid test note\ntags:\n  - test\n---\n"
            "# Note\n\nSome content with [[a wikilink]] and more text.\n" + "x" * 300
        )
        stdout, _, rc = self._run(path)
        self.assertEqual(rc, 0)
        self.assertEqual(stdout.strip(), "")

    # -- Type safety --

    def test_null_tool_input(self):
        _, _, rc = run_script(self.SCRIPT, {"tool_input": None})
        self.assertEqual(rc, 0)

    def test_non_string_file_path(self):
        _, _, rc = run_script(self.SCRIPT, {"tool_input": {"file_path": 123}})
        self.assertEqual(rc, 0)

    def test_invalid_json(self):
        cmd = [sys.executable, os.path.join(SCRIPT_DIR, self.SCRIPT)]
        proc = subprocess.run(cmd, input="not json", capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0)

    def test_nonexistent_file(self):
        _, _, rc = self._run("/nonexistent/path/note.md")
        self.assertEqual(rc, 0)

    def test_empty_object(self):
        _, _, rc = run_script(self.SCRIPT, {})
        self.assertEqual(rc, 0)


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    unittest.main()
