#!/bin/bash
set -euo pipefail
# Count characters in a markdown section (useful for review tools with character limits)
# Usage: charcount.sh <file> <section> [subsection]
# Examples:
#   charcount.sh review.md "Project Name"
#   charcount.sh review.md "Competency Name" "Current Level"
#   charcount.sh review.md "Competency Name" "Next Level"

FILE="$1"
SECTION="$2"
SUB="$3"

if [ -z "$FILE" ] || [ -z "$SECTION" ]; then
    echo "Usage: charcount.sh <file> \"Section Header\" [subsection]"
    exit 1
fi

if [ ! -f "$FILE" ]; then
    echo "File not found: $FILE"
    exit 1
fi

if [ -n "$SUB" ]; then
    MARKER="**${SUB}:**"
    awk -v section="$SECTION" -v marker="$MARKER" '
        index($0, "### " section) { found=1; next }
        found && /^### / { exit }
        found && index($0, marker) { capture=1; next }
        found && capture && /^\*\*/ { exit }
        found && capture && /^### / { exit }
        found && capture && $0 != "" { print }
    ' "$FILE" | tr -d '\n' | wc -m | tr -d ' '
else
    awk -v section="$SECTION" '
        index($0, "### " section) { found=1; next }
        found && /^### / { exit }
        found && /^## / { exit }
        found && $0 != "" { print }
    ' "$FILE" | tr -d '\n' | wc -m | tr -d ' '
fi
