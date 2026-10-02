#!/usr/bin/env bash
# Shared safety checks for disposable demo fixtures on Linux.
TARGET_DIR="${DEMO_PROJECT_DIR:-${1:-/tmp/demo-proj}}"
TEMP_ROOT="$(realpath -e -- "${TMPDIR:-/tmp}")"
CANONICAL_TARGET="$(realpath -m -- "$TARGET_DIR")"
if [[ "$TARGET_DIR" != "$CANONICAL_TARGET" || "$CANONICAL_TARGET" != "$TEMP_ROOT/"* || -L "$TARGET_DIR" ]]; then
  echo "Refusing demo target: use a canonical directory inside the temporary directory." >&2
  exit 1
fi
MARKER="$TARGET_DIR/.git/spawnea-demo-fixture"
if [[ -e "$TARGET_DIR" ]]; then
  if [[ ! -d "$TARGET_DIR" ]]; then
    echo "Refusing demo target: target is not a directory." >&2
    exit 1
  fi
  if [[ -f "$MARKER" && ! -L "$TARGET_DIR/.git" && ! -L "$MARKER" && "$(cat "$MARKER")" == "$CANONICAL_TARGET" ]]; then
    DEMO_INITIALIZED=1
  elif [[ -n "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "Refusing demo target: existing content is not a managed demo fixture." >&2
    exit 1
  fi
fi
