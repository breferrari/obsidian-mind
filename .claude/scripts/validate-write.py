#!/usr/bin/env python3
"""Post-write validation for vault notes."""
import json
import sys
import os
from pathlib import Path

def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")

    # Only validate markdown files in the vault, skip dotfiles and templates
    if not file_path.endswith(".md"):
        sys.exit(0)
    # Normalize path separators for cross-platform matching (Windows uses backslashes)
    normalized = file_path.replace("\\", "/")
    # Skip dotfiles, templates, thinking, and root template files (not vault notes)
    basename = os.path.basename(normalized)
    root_files = {"README.md", "CHANGELOG.md", "CONTRIBUTING.md", "CLAUDE.md"}
    if basename in root_files:
        sys.exit(0)
    if any(skip in normalized for skip in [".claude/", ".obsidian/", "templates/", "thinking/"]):
        sys.exit(0)

    warnings = []

    try:
        content = Path(file_path).read_text(encoding="utf-8")

        # Check for frontmatter
        if not content.startswith("---"):
            warnings.append("Missing YAML frontmatter")
        else:
            parts = content.split("---", 2)
            if len(parts) >= 3:
                fm = parts[1]
                if "tags:" not in fm and "tags :" not in fm:
                    warnings.append("Missing `tags` in frontmatter")
                if "description:" not in fm and "description :" not in fm:
                    warnings.append("Missing `description` in frontmatter (~150 chars required by vault convention)")
                if "date:" not in fm and "date :" not in fm:
                    warnings.append("Missing `date` in frontmatter")

        # Check for wikilinks (skip very short notes)
        if len(content) > 300 and "[[" not in content:
            warnings.append("No [[wikilinks]] found — every note must link to at least one other note (vault convention)")

    except Exception:
        sys.exit(0)

    if warnings:
        basename = os.path.basename(file_path)
        hint_list = "\n".join(f"  - {w}" for w in warnings)
        output = {
            "hookSpecificOutput": {
                "additionalContext": f"Vault hygiene warnings for `{basename}`:\n{hint_list}\nFix these before moving on."
            }
        }
        json.dump(output, sys.stdout)
        sys.stdout.flush()

    sys.exit(0)

if __name__ == "__main__":
    main()
