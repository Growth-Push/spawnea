# Spawnea Harness Hooks (`harness_hooks/`)

This directory provides standardized, documented reference hooks, scripts, and configuration examples for integrating LLM coding agents (harnesses) with Spawnea's status tracking engine.

---

## 1. Architectural Role

Spawnea connects to local and remote machines running coding harnesses inside persistent `tmux` sessions. To detect whether an agent is `working`, `waiting_input`, `idle`, `finished`, or `error`, Spawnea uses a multi-tier precedence model:

```text
Native Hooks / Events (Confidence: 0.95 - 1.0)
        ↓
Terminal Snapshot & Prompt Heuristics (Confidence: 0.80 - 0.90)
        ↓
Process Table & PTY Output Stream (Confidence: 0.60 - 0.75)
        ↓
Disconnected / Unknown Fallback (Confidence: 0.50)
```

By configuring harnesses with these lightweight hook scripts, Spawnea achieves **zero-ambiguity, real-time status transitions** without requiring a heavy background daemon or permanent remote software packages.

---

## 2. Directory Structure

```text
harness_hooks/
├── README.md                 # This guide
├── codex/                    # OpenAI Codex CLI hooks & configuration
│   ├── README.md             # Detailed guide & payload specifications
│   ├── notify.sh             # Executable notify handler for turn completion
│   ├── config.toml.example   # Example user/session config.toml
│   └── hooks.json.example    # Example experimental hooks.json
├── claude/                   # Anthropic Claude Code hooks & configuration
│   ├── README.md             # Claude Code PreToolUse / PostToolUse guide
│   ├── hook-handler.sh       # Unified hook handler script
│   └── settings.json.example # Example settings.json hook definition
├── antigravity/              # Google Antigravity / Gemini CLI hooks
│   ├── README.md             # Antigravity hook integration guide
│   └── notify-handler.sh     # Notify handler script
└── generic/                  # Fallback & custom harness integration
    ├── README.md             # Generic POSIX hook documentation
    └── spawnea-hook.sh      # Universal event logger script
```

---

## 3. How Spawnea Uses These Hooks

### A. Automatic Session Instrumentation (Zero Required Remote Install)
When Spawnea starts a session, it automatically prepares a temporary session-scoped directory at:
```text
/tmp/spawnea/<session-id>/
├── bin/
│   └── spawnea-hook.sh      # Generated from harness_hooks templates (chmod 0755)
└── events.jsonl              # Append-only event log
```
Spawnea injects this temporary script when invoking the harness CLI (e.g. `codex -c notify='["/tmp/spawnea/<session-id>/bin/spawnea-hook.sh", "agent-turn-complete"]'`).

### B. Manual / Permanent User Configuration (Optional)
If you wish to configure your personal development environment permanently so that any manual terminal session also reports to Spawnea or tmux, you can copy these scripts into your home directory (e.g. `~/.codex/notify.sh` or `~/.claude/hooks/`) and reference them in your global configs.

---

## 4. Universal Event Schema (`events.jsonl`)

Every hook script appends structured JSON lines in this format:

```json
{
  "sessionId": "sess-12345",
  "harness": "codex",
  "eventType": "turn_complete",
  "timestamp": "2026-08-24T17:50:00Z",
  "payload": {
    "type": "agent-turn-complete",
    "turn-id": "turn-987",
    "last-assistant-message": "All unit tests are passing."
  }
}
```

In addition to appending to `events.jsonl`, scripts update the tmux user option:
```bash
tmux set-option -t "$TMUX_SESSION" "@spawnea_last_event" "${EVENT_TYPE}::${TIMESTAMP}"
```
This allows Spawnea to inspect session state with near-zero latency and minimal CPU/network overhead.
