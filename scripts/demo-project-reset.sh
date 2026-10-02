#!/usr/bin/env bash
set -euo pipefail

# Removes and recreates the disposable Git repository for Spawnea recording demos.
# Default target is /tmp/demo-proj unless overridden by DEMO_PROJECT_DIR or an argument.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/demo-project-common.sh"

if [[ "${DEMO_INITIALIZED:-0}" == 1 ]]; then
  rm -rf -- "$TARGET_DIR"
fi

DEMO_PROJECT_DIR="$TARGET_DIR" "$SCRIPT_DIR/demo-project-init.sh"
