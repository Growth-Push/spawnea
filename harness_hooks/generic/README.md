# Generic / Custom Agent Hook Integration

This document details how any custom CLI tool, shell script, or experimental agent can emit lifecycle events to Spawnea.

---

## 1. Usage

Invoke `spawnea-hook.sh`:
```bash
/path/to/spawnea-hook.sh <event_type> [optional_json_payload]
```

### Supported `event_type` Values:
- `turn_complete` $\longrightarrow$ transitions status to `idle`
- `tool_start` $\longrightarrow$ transitions status to `working`
- `tool_complete` $\longrightarrow$ transitions status to `working`
- `permission_requested` $\longrightarrow$ transitions status to `waiting_input`
- `error` $\longrightarrow$ transitions status to `error`
