# OpenAI Codex CLI Hook Integration

This document details how OpenAI Codex CLI connects with Spawnea's status tracking engine.

---

## 1. Capabilities & Event Model

Codex CLI exposes two primary integration mechanisms:

### A. The `notify` Hook (Recommended / Production)
* **Configuration:** Defined in `config.toml` (or CLI override `-c notify='[...]'`).
* **Trigger:** Invoked on **turn completion** (`agent-turn-complete`).
* **Payload:** Codex appends a JSON string as the last argument:
  ```json
  {
    "type": "agent-turn-complete",
    "thread-id": "019488a1-b2c3-7d8e-9f0a-1234567890ab",
    "turn-id": "turn-42",
    "cwd": "/workspace/project",
    "last-assistant-message": "I've created the unit tests and updated the index.ts file.",
    "input-messages": ["Please implement the state adapter"]
  }
  ```
* **State Transition in Spawnea:** Transitions status $\longrightarrow$ `idle` (Confidence: 0.98, Source: `native_hook`).

### B. Experimental `hooks.json`
* **Configuration:** Enabled with `[features] codex_hooks = true` in `config.toml` and defined in `$CODEX_HOME/hooks.json`.
* **Events:**
  - `SessionStart` $\longrightarrow$ `idle`
  - `UserPromptSubmit` $\longrightarrow$ `working`
  - `PreToolUse` $\longrightarrow$ `working`
  - `PostToolUse` $\longrightarrow$ `working`

---

## 2. Invocations & CLI Overrides

Spawnea launches Codex sessions with session-scoped CLI overrides without modifying `~/.codex/config.toml`:

```bash
codex -c notify='["/bin/sh", "/tmp/spawnea/<session-id>/bin/notify.sh", "agent-turn-complete"]'
```

---

## 3. Handling Mid-Turn Prompts (Waiting for Input)

When Codex prompts the user for interactive approval (e.g. `Proceed? [y/N]` or multiple-choice questions), no separate event is emitted. Spawnea uses its high-confidence **terminal prompt heuristics** as a Tier 2 fallback during active turns to detect `waiting_input`.
