#!/usr/bin/env sh
# ==============================================================================
# Spawnea - Claude Code Lifecycle Hook Script
#
# Called by Claude Code on lifecycle events (PreToolUse, PostToolUse, Stop).
# Event payload is provided via STDIN or arguments.
# ==============================================================================

set -e

SESSION_ID="${SPAWNEA_SESSION_ID:-${1:-default}}"
EVENT_TYPE="${2:-tool_start}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")

BASE_DIR="/tmp/spawnea/${SESSION_ID}"
EVENTS_FILE="${BASE_DIR}/events.jsonl"

# Read payload from stdin if available
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat | tr '\n' ' ' | sed 's/\\/\\\\/g' | sed 's/"/\\"/g')
fi

if [ -d "${BASE_DIR}" ]; then
  printf '{"sessionId":"%s","harness":"claude","eventType":"%s","timestamp":"%s","rawPayload":"%s"}\n' \
    "${SESSION_ID}" "${EVENT_TYPE}" "${TIMESTAMP}" "${STDIN_DATA}" >> "${EVENTS_FILE}" 2>/dev/null || true
fi

TMUX_SESSION="${SPAWNEA_TMUX_SESSION:-$(tmux display-message -p '#S' 2>/dev/null || true)}"
if [ -n "${TMUX_SESSION}" ] && command -v tmux >/dev/null 2>&1; then
  tmux set-option -t "${TMUX_SESSION}" "@spawnea_last_event" "${EVENT_TYPE}::${TIMESTAMP}" 2>/dev/null || true
fi

exit 0
