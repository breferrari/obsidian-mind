#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

INPUT=$(cat)
IFS=$'\t' read -r TRANSCRIPT_PATH TRIGGER <<< "$(echo "$INPUT" | node --experimental-strip-types "$SCRIPT_DIR/lib/read-field.ts" transcript_path trigger 2>/dev/null || printf '\tunknown')"

if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  BACKUP_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/thinking/session-logs"
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  cp "$TRANSCRIPT_PATH" "$BACKUP_DIR/session_${TRIGGER}_${TIMESTAMP}.jsonl"

  # Keep last 30 backups, prune older ones
  ls -t "$BACKUP_DIR"/session_*.jsonl 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
fi

exit 0
