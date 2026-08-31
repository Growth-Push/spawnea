#!/usr/bin/env sh
# ==============================================================================
# Spawnea - Codex Turn Notification Hook Script
#
# Called by OpenAI Codex CLI when an agent turn completes via the `notify` config.
# Codex passes the JSON payload as the first argument ($1).
# ==============================================================================

set -e

# Session ID can be provided via environment or positional fallback
SESSION_ID="${SPAWNEA_SESSION_ID:-${1:-default}}"
RAW_PAYLOAD="${2:-${1:-{}}}"

# If first arg is JSON payload, parse accordingly
if [ "$#" -ge 2 ]; then
  EVENT_NAME="$1"
  RAW_PAYLOAD="$2"
else
  EVENT_NAME="agent-turn-complete"
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")

# Resolve session directory
BASE_DIR="/tmp/spawnea/${SESSION_ID}"
EVENTS_FILE="${BASE_DIR}/events.jsonl"

# Ensure base dir exists if writing
if [ -d "${BASE_DIR}" ]; then
  # Sanitize payload: ensure it is a valid single-line JSON string
  SAFE_PAYLOAD=$(printf '%s' "${RAW_PAYLOAD}" | tr '\n' ' ' | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')

  # Write structured event record
  printf '{"sessionId":"%s","harness":"codex","eventType":"%s","timestamp":"%s","rawPayload":"%s"}\n' \
    "${SESSION_ID}" "${EVENT_NAME}" "${TIMESTAMP}" "${SAFE_PAYLOAD}" >> "${EVENTS_FILE}" 2>/dev/null || true
fi

# Update tmux user option if running inside tmux
TMUX_SESSION="${SPAWNEA_TMUX_SESSION:-$(tmux display-message -p '#S' 2>/dev/null || true)}"
if [ -n "${TMUX_SESSION}" ] && command -v tmux >/dev/null 2>&1; then
  tmux set-option -t "${TMUX_SESSION}" "@spawnea_last_event" "turn_complete::${TIMESTAMP}" 2>/dev/null || true
fi

exit 0
