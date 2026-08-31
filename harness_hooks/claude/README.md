# Claude Code Hook Integration

This document details how Anthropic Claude Code connects with Spawnea's status tracking engine.

---

## 1. Capabilities & Lifecycle Hooks

Claude Code supports lifecycle hooks configured inside `settings.json`:
* **`PreToolUse`**: Triggers before a tool (Bash, Read, Write) runs $\longrightarrow$ Spawnea status: `working`.
* **`PostToolUse`**: Triggers after tool execution finishes $\longrightarrow$ Spawnea status: `working`.
* **`Stop`**: Triggers when agent turn finishes $\longrightarrow$ Spawnea status: `idle`.

---

## 2. Session-Scoped Instrumentation

Spawnea passes `CLAUDE_CONFIG_DIR=/tmp/spawnea/<session-id>/config/` so session-scoped `settings.json` is loaded without overwriting global `~/.claude/settings.json`.
