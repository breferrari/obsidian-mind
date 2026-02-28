#!/bin/bash
set -euo pipefail
trap 'exit 0' ERR

# Consume hook input
cat > /dev/null 2>&1 || true

file_listing=$(find "$CLAUDE_PROJECT_DIR" \
  -not -path '*/.git/*' \
  -not -path '*/.obsidian/*' \
  -not -path '*/.claude/*' \
  -not -path '*/.claude-plugin/*' \
  -not -name '.DS_Store' \
  -not -name '.gitignore' \
  -type f \
  | sed "s|$CLAUDE_PROJECT_DIR/||" \
  | sort)

[ -z "$file_listing" ] && exit 0

# Structured output if jq available, plain text otherwise
if command -v jq >/dev/null 2>&1; then
  jq -n --arg files "$file_listing" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $files
    }
  }'
else
  echo "$file_listing"
fi
