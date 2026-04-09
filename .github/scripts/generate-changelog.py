#!/usr/bin/env python3
"""Generate a CHANGELOG.md entry from commits since the previous tag.

Usage: generate-changelog.py <version>
  e.g. generate-changelog.py v3.8

Outputs:
  - Prepends new section to CHANGELOG.md (or replaces if version exists)
  - Updates vault-manifest.json version and released date
  - Prints the generated section to stdout (for use as GitHub Release body)
"""

import json
import re
import subprocess
import sys
from datetime import datetime, timezone

PREFIX_MAP = {
    "feat": "Added",
    "fix": "Fixed",
    "docs": "Changed",
    "ci": "Changed",
    "refactor": "Changed",
    "perf": "Changed",
    "test": "Changed",
    "chore": "Changed",
    "build": "Changed",
    "style": "Changed",
    "revert": "Fixed",
}

SKIP_PREFIXES = {"release", "ci", "test"}

SECTION_ORDER = ["Added", "Changed", "Fixed", "Removed"]


def run_git(*args):
    result = subprocess.run(
        ["git"] + list(args),
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"git {' '.join(args)} failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def get_previous_tag():
    output = run_git("tag", "--sort=-version:refname")
    tags = [t.strip() for t in output.split("\n") if t.strip()]
    if len(tags) >= 2:
        return tags[1]
    return None


def get_commits(since_tag):
    if since_tag:
        range_spec = f"{since_tag}..HEAD"
    else:
        range_spec = "HEAD"

    output = run_git("log", range_spec, "--pretty=format:%s", "--first-parent")
    return [line.strip() for line in output.split("\n") if line.strip()]


def classify_commit(message):
    # Strip PR reference suffix like (#25)
    clean = re.sub(r'\s*\(#\d+\)\s*$', '', message)

    # Try prefix match: "feat: description" or "feat(scope): description"
    match = re.match(r'^(\w+)(?:\([^)]*\))?\s*:\s*(.+)$', clean)
    if match:
        prefix = match.group(1).lower()
        description = match.group(2).strip()
        if prefix in SKIP_PREFIXES:
            return None, None
        category = PREFIX_MAP.get(prefix, "Changed")
        return category, description

    # No prefix — capitalize first letter, put in Changed
    if not clean:
        return "Changed", clean
    return "Changed", clean[0].upper() + clean[1:]


def generate_section(version, commits):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    grouped = {}

    for msg in commits:
        category, description = classify_commit(msg)
        if category is None:
            continue
        if category not in grouped:
            grouped[category] = []
        grouped[category].append(description)

    lines = [f"## {version} — {today}", ""]

    for section in SECTION_ORDER:
        if section in grouped:
            lines.append(f"### {section}")
            for item in grouped[section]:
                lines.append(f"- {item}")
            lines.append("")

    return "\n".join(lines)


def prepend_to_changelog(section, version):
    with open("CHANGELOG.md", "r", encoding="utf-8") as f:
        content = f.read()

    # Check if this version already exists (idempotent on re-runs)
    version_pattern = rf"(?m)^## {re.escape(version)} — .*$"
    # Match everything from this version header up to the next version header (or end of file)
    existing_pattern = rf"(?ms)^## {re.escape(version)} — .*?(?=\n## [^\n]|\Z)"
    if re.search(version_pattern, content):
        new_content = re.sub(existing_pattern, section.rstrip(), content, count=1)
    else:
        # Insert after the "# Changelog" header
        header = "# Changelog"
        idx = content.find(header)
        if idx == -1:
            new_content = f"{header}\n\n{section}\n{content}"
        else:
            insert_at = idx + len(header)
            while insert_at < len(content) and content[insert_at] in ("\n", "\r"):
                insert_at += 1
            new_content = content[:insert_at] + "\n" + section + "\n" + content[insert_at:]

    with open("CHANGELOG.md", "w", encoding="utf-8") as f:
        f.write(new_content)


def normalize_version(version):
    match = re.fullmatch(r"v?(\d+)\.(\d+)(?:\.(\d+))?", version)
    if not match:
        print(f"Invalid version '{version}'. Expected vX.Y or vX.Y.Z.", file=sys.stderr)
        sys.exit(1)
    major, minor, patch = match.groups()
    return f"{major}.{minor}.{patch or '0'}"


def update_manifest(version):
    with open("vault-manifest.json", "r", encoding="utf-8") as f:
        manifest = json.load(f)

    manifest["version"] = normalize_version(version)
    manifest["released"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    with open("vault-manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    if len(sys.argv) < 2:
        print("Usage: generate-changelog.py <version>", file=sys.stderr)
        sys.exit(1)

    version = sys.argv[1]
    prev_tag = get_previous_tag()
    commits = get_commits(prev_tag)

    if not commits:
        print("No commits found since previous tag.", file=sys.stderr)
        sys.exit(1)

    section = generate_section(version, commits)

    if not any(classify_commit(msg)[0] is not None for msg in commits):
        print("All commits were skipped (ci/test/release only). Nothing to changelog.", file=sys.stderr)
        sys.exit(1)

    prepend_to_changelog(section, version)
    update_manifest(version)

    # Print section for GitHub Release body
    print(section)


if __name__ == "__main__":
    main()
