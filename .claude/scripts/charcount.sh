#!/bin/bash
set -euo pipefail
# Count characters in a markdown section, optionally validate against a limit.
# Usage: charcount.sh <file> <section> [subsection] [limit]
# Examples:
#   charcount.sh review.md "Project Name"                    → 847
#   charcount.sh review.md "Project Name" "" 1000            → 847/1000 ✓
#   charcount.sh review.md "Project Name" "" 500             → 847/500 ✗ (over by 347)
#   charcount.sh review.md "Competency Name" "Current Level" 1000

FILE="${1:-}"
SECTION="${2:-}"
SUB="${3:-}"
LIMIT="${4:-}"

if [ -z "$FILE" ] || [ -z "$SECTION" ]; then
    echo "Usage: charcount.sh <file> \"Section Header\" [subsection] [limit]"
    echo "  subsection: use \"\" to skip when passing a limit"
    exit 1
fi

if [ ! -f "$FILE" ]; then
    echo "File not found: $FILE"
    exit 1
fi

if [ -n "$SUB" ]; then
    MARKER="**${SUB}:**"
    COUNT=$(awk -v section="$SECTION" -v marker="$MARKER" '
        index($0, "### " section) { found=1; next }
        found && /^### / { exit }
        found && index($0, marker) { capture=1; next }
        found && capture && /^\*\*/ { exit }
        found && capture && /^### / { exit }
        found && capture && $0 != "" { print }
    ' "$FILE" | tr -d '\n' | wc -m | tr -d ' ')
else
    COUNT=$(awk -v section="$SECTION" '
        index($0, "### " section) { found=1; next }
        found && /^### / { exit }
        found && /^## / { exit }
        found && $0 != "" { print }
    ' "$FILE" | tr -d '\n' | wc -m | tr -d ' ')
fi

if [ -n "$LIMIT" ]; then
    if [ "$COUNT" -le "$LIMIT" ]; then
        echo "${COUNT}/${LIMIT} ✓"
    else
        OVER=$((COUNT - LIMIT))
        echo "${COUNT}/${LIMIT} ✗ (over by ${OVER})"
        exit 1
    fi
else
    echo "$COUNT"
fi
