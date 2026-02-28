#!/bin/bash
set -euo pipefail

project_path="${MCS_PROJECT_PATH:?MCS_PROJECT_PATH not set}"
pack_path="$(cd "$(dirname "$0")/.." && pwd)"
scaffold_dir="$pack_path/scaffold"

echo "Scaffolding Obsidian Mind vault structure..."

for dir in claude perf perf/competencies templates thinking work; do
  mkdir -p "$project_path/$dir"
done

copy_if_missing() {
  local src="$1" dest="$2"
  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    echo "  Created: ${dest#$project_path/}"
  else
    echo "  Skipped (exists): ${dest#$project_path/}"
  fi
}

find "$scaffold_dir" -type f | sort | while read -r src; do
  relative="${src#$scaffold_dir/}"
  copy_if_missing "$src" "$project_path/$relative"
done

# ── Obsidian config (pre-configure core plugins and template folder) ──
obsidian_dir="$project_path/.obsidian"
mkdir -p "$obsidian_dir"

write_if_missing() {
  local dest="$1" content="$2"
  if [ ! -f "$dest" ]; then
    echo "$content" > "$dest"
    echo "  Created: ${dest#$project_path/}"
  else
    echo "  Skipped (exists): ${dest#$project_path/}"
  fi
}

write_if_missing "$obsidian_dir/core-plugins.json" '{
  "file-explorer": true,
  "global-search": true,
  "switcher": true,
  "graph": true,
  "backlink": true,
  "canvas": true,
  "outgoing-link": true,
  "tag-pane": true,
  "properties": true,
  "page-preview": true,
  "daily-notes": true,
  "templates": true,
  "note-composer": true,
  "command-palette": true,
  "editor-status": true,
  "bookmarks": true,
  "outline": true,
  "word-count": true,
  "file-recovery": true,
  "bases": true
}'

write_if_missing "$obsidian_dir/templates.json" '{
  "folder": "templates"
}'

echo "Vault scaffolding complete."
