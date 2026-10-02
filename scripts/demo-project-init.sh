#!/usr/bin/env bash
set -euo pipefail

# Initializes a clean, disposable Git repository for Spawnea recording demos.
# Default target is /tmp/demo-proj unless overridden by DEMO_PROJECT_DIR or an argument.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/demo-project-common.sh"

if [[ "${DEMO_INITIALIZED:-0}" == 1 ]]; then
  echo "Demo project already initialized at $TARGET_DIR."
  echo "To recreate it cleanly, run: ./scripts/demo-project-reset.sh"
  exit 0
fi

mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

git init --quiet
git checkout -B main --quiet

# Ensure consistent identity for the disposable demo repository
git config user.name "Demo Operator"
git config user.email "demo@example.com"

cat << 'EOF' > README.md
# Demo Project

A disposable test repository for verifying Spawnea multi-harness workflows.
EOF

git add README.md
git commit -m "initial commit" --quiet

printf '%s\n' "$CANONICAL_TARGET" > "$MARKER"

echo "Initialized demo project at $TARGET_DIR"
