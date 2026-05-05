#!/usr/bin/env bash
set -euo pipefail

PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-}"
PAPERCLIP_API_KEY="${PAPERCLIP_API_KEY:-}"
PAPERCLIP_RUN_ID="${PAPERCLIP_RUN_ID:-}"
PAPERCLIP_TASK_ID="${PAPERCLIP_TASK_ID:-}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <status> <comment_file>"
  exit 1
fi

STATUS="$1"
COMMIT_MESSAGE="$2"

BODY=$(jq -n \
  --arg status "$STATUS" \
  --arg comment "$COMMIT_MESSAGE" \
  '{status: $status, comment: $comment}')

curl -sS "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -X PATCH \
  -d "$BODY"
