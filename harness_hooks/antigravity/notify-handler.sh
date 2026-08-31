#!/usr/bin/env sh
# ==============================================================================
# Spawnea - Antigravity / Gemini Hook Script
#
# Called on Antigravity turn completion and lifecycle events.
# ==============================================================================

set -e

SESSION_ID="${SPAWNEA_SESSION_ID:-${1:-default}}"
EVENT_TYPE="${2:-turn_complete}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")

BASE_DIR="/tmp/spawnea/${SESSION_ID}"
EVENTS_FILE="${BASE_DIR}/events.jsonl"

if [ -d "${BASE_DIR}" ]; then
  printf '{"sessionId":"%s","harness":"antigravity","eventType":"%s","timestamp":"%s"}\n' \
    "${SESSION_ID}" "${EVENT_TYPE}" "${TIMESTAMP}" >> "${EVENTS_FILE}" 2>/dev/null || true
fi

TMUX_SESSION="${SPAWNEA_TMUX_SESSION:-$(tmux display-message -p '#S' 2>/dev/null || true)}"
if [ -n "${TMUX_SESSION}" ] && command -v tmux >/dev/null 2>&1; then
  tmux set-option -t "${TMUX_SESSION}" "@spawnea_last_event" "${EVENT_TYPE}::${TIMESTAMP}" 2>/dev/null || true
fi

exit 0
