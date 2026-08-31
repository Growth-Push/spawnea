# Spawnea local control API / MCP v1

Spawnea exposes a local MCP surface for inspecting sessions, renaming session display titles, creating session batches, navigating the desktop UI, and requesting guarded worktree finalization. It is enabled by default and does not open an HTTP or network port.

## Enable and connect

1. Build Spawnea with `pnpm build`.
2. Start the desktop app with `pnpm app`.
3. Configure the MCP client to launch the stdio bridge:

```json
{
  "mcpServers": {
    "spawnea": {
      "command": "node",
      "args": ["/absolute/path/to/spawnea/apps/desktop/out/main/spawnea-mcp.js"]
    }
  }
}
```

The bridge finds the active desktop process through `${XDG_RUNTIME_DIR}/spawnea/control-runtime.json`. Set `SPAWNEA_CONTROL_RUNTIME_FILE` in both processes only when a non-default runtime file is required. Stop the desktop app to disable the integration; without an active app, the bridge exits because its owner socket closes. Set `SPAWNEA_CONTROL_ENABLED=0`, `false`, `off`, `no`, or `disabled` only when the local MCP socket should be disabled intentionally.

The v1 bridge exposes only the canonical `spawnea_*` tools documented below; no legacy MCP tool aliases are currently registered. `SPAWNEA_CONTROL_*` environment variables remain fallbacks, the legacy runtime descriptor location is discovered by the bridge, and both local authentication message names are accepted. New integrations should use the canonical Spawnea names.

## Transport and authorization boundary

- The MCP client communicates with a dedicated stdio bridge. Protocol output is written only to stdout; diagnostics go to stderr.
- The bridge connects to a Unix-domain socket owned by the current OS user. The runtime directory is mode `0700`; the socket and ephemeral-token descriptor are mode `0600`.
- A detached same-user watchdog removes the descriptor and socket after abrupt Electron termination, but only while the protected descriptor still names the exited Electron PID.
- The gateway starts by default with the desktop app. Set `SPAWNEA_CONTROL_ENABLED=0` (or `false`, `off`, `no`, `disabled`) to disable it. There is no TCP listener, public API, remote daemon, or remote host installation.
- Every socket connection must authenticate with the random 256-bit token from the protected runtime descriptor before MCP messages are accepted.
- The read model returns host IDs and display names, never SSH targets, usernames, passwords, tokens, secret references, or resolved credentials.
- Zod schemas reject malformed tool input before the control service can call a host adapter, tmux, or Git.

Any process running as the same OS user can normally read that user's files and interact with that user's desktop applications. The token and file permissions prevent access from other users and accidental unauthenticated connections; they are not a sandbox against a malicious process already running as the operator.

## Tools

All structured responses include `apiVersion: "v1"` where the response is owned by Spawnea.

### `spawnea_get_state`

No arguments. Returns:

```json
{
  "apiVersion": "v1",
  "ui": { "activeSessionId": "session-id", "activeTab": "diff" },
  "sessions": [{
    "id": "session-id",
    "name": "Fix retries",
    "task": "Fix retry handling",
    "host": { "id": "local", "name": "Local workstation" },
    "project": { "id": "spawnea", "name": "Spawnea" },
    "harness": { "id": "codex", "name": "Codex", "command": "codex" },
    "worktree": { "managed": true, "path": "/repo/worktrees/retries", "branch": "spawnea/retries", "baseBranch": "main" },
    "creationSource": "mcp",
    "status": "working",
    "active": true,
    "activeTab": "diff"
  }],
  "hosts": [], "projects": [], "harnesses": [], "recentErrors": []
}
```

### `spawnea_inspect_worktree`

Input: `{ "sessionId": "session-id" }`. Runs the existing non-mutating managed-worktree identity inspection and returns its state and explanation.

### `spawnea_rename_session`

Input: `{ "sessionId": "session-id", "title": "Focused retry review" }`. Updates only the session's operator-facing display title. Input is trimmed, must not be empty, and may contain at most 120 characters. The operation delegates to the same `SessionManager.renameSession()` path used by the renderer, so SQLite and the Spawnea context file remain synchronized while `task`, `tmuxSessionName`, branch, and worktree identity stay unchanged.

The result contains the updated sanitized session view and `deliveredToRenderer`, which truthfully reports whether Main notified a live renderer to reload persisted state. A false value does not mean persistence failed; a later `spawnea_get_state` still returns the stored title.

```json
{
  "apiVersion": "v1",
  "session": {
    "id": "session-id",
    "name": "Focused retry review",
    "task": "Fix retry handling",
    "tmuxSessionName": "spawnea-fix-retry-handling",
    "worktree": {
      "managed": true,
      "path": "/repo/worktrees/retries",
      "branch": "spawnea/retries",
      "baseBranch": "main"
    }
  },
  "deliveredToRenderer": true
}
```

Unknown sessions return a `not_found` tool error. Blank or oversized titles are rejected before persistence.

### `spawnea_create_sessions`

Creates 1–20 sessions sequentially. `correlationId` makes an exact retry idempotent. Each item requires a unique `clientRequestId`, and every item receives its own result, so partial success is explicit.

```json
{
  "correlationId": "setup-2026-08-27-1",
  "sessions": [
    {
      "clientRequestId": "api-tests",
      "serverId": "local",
      "projectId": "spawnea",
      "agentId": "codex",
      "task": "Add API contract tests",
      "baseBranch": "main",
      "useWorktree": true
    }
  ]
}
```

A repeated correlation ID with a different payload is rejected. An exact retry returns the cached per-item result with `replayed: true` and creates nothing twice.

### `spawnea_activate`

Input: `{ "sessionId": "session-id", "tab": "terminal|files|diff|artifacts|details" }`. Selects a known session/tab in the live renderer. It does not run host or Git commands. The result says whether delivery to a live renderer occurred.

### `spawnea_request_finalization`

Requests guarded worktree finalization. Integrate always creates a pending request and waits for trusted renderer approval. Close requires `dirtyChanges` to be `stash` or `discard`.

When the MCP caller's LLM has explicitly approved the close, it must also send:

```json
{ "confirmation": "llm-validated" }
```

That explicit protocol signal selects `mode: "mcp-validated"`. Spawnea executes the close through the existing `SessionManager.finishSession` safety path and does not emit a renderer confirmation event. The result remains queryable through `spawnea_get_finalization_request`, including any identity, worktree, branch, dirty-state, authorization, host, or Git error returned by the authoritative path.

Without the signal, the request selects `mode: "ui-confirmation"` and remains pending for the existing renderer confirmation flow. The signal is valid only for `close`; it cannot authorize `integrate`.

```json
{
  "clientRequestId": "finish-retries-1",
  "sessionId": "session-id",
  "action": "integrate"
}
```

For close, the caller must state what should happen to dirty changes:

```json
{
  "clientRequestId": "close-retries-1",
  "sessionId": "session-id",
  "action": "close",
  "dirtyChanges": "stash"
}
```

`dirtyChanges` must be `stash` or `discard`. The latter is explicitly permanent. UI-confirmation requests display a blocking confirmation dialog containing the session, branches, worktree path, and exact consequences. Validated MCP closes do not display that dialog, but they still pass the same authoritative finalization checks. Only the renderer preload exposes approval/rejection for pending requests.

### `spawnea_get_finalization_request`

Input: `{ "requestId": "uuid-returned-above" }`. Returns one of `pending`, `executing`, `completed`, `rejected`, or `failed`, plus the truthful result/error. Clients must not interpret a pending request as success.

## Threat-model decisions

| Threat | Boundary / mitigation |
| --- | --- |
| Network exposure | Unix-domain socket only; no TCP/HTTP listener. |
| Integration not wanted | Explicit `SPAWNEA_CONTROL_ENABLED=0`/`false`/`off`/`no`/`disabled` disables the local gateway. |
| Other local users | Owner-only runtime directory, socket, descriptor, and per-run random token. |
| Malformed or oversized input | Authentication line limit, MCP transport buffer limit, strict schemas and batch limit. |
| Credential disclosure | Sanitized control DTOs omit connection targets and all credential fields. |
| Retry creates duplicates | Correlation ID plus payload fingerprint cache. |
| Ambiguous batch failure | One success/error result per `clientRequestId`. |
| Autonomous destructive Git | Integrate and unvalidated MCP requests require trusted UI approval. A close may execute without the dialog only when the authenticated MCP request carries the explicit `llm-validated` protocol signal; the existing finalization guards still decide whether it can mutate anything. |
| Accidental dirty-work loss | Close requires an explicit `stash` or `discard` choice; UI-confirmation requests repeat it in the dialog, while validated MCP closes carry it in the authenticated request. |
| False success | Finalization status and actual `FinishSessionResult`/error remain queryable. |

## Manual smoke checklist

Use a disposable Git repository and a disposable Spawnea managed-worktree session.

1. Start Spawnea and connect an MCP client using the bridge above.
2. Call `spawnea_get_state`; confirm host addresses and credentials are absent.
3. Call `spawnea_rename_session`; confirm the context bar/sidebar update, `spawnea_get_state` returns the new title, and the task/tmux/branch/worktree fields are unchanged.
4. Call `spawnea_create_sessions` with one valid and one deliberately invalid item; confirm explicit partial results, then retry the exact request and confirm `replayed: true`.
5. Call `spawnea_activate` and `spawnea_inspect_worktree`; confirm the selected tab changes and the repository remains unchanged.
6. Request `close` with `dirtyChanges: "discard"` and no confirmation; confirm no Git/tmux mutation occurs while the dialog is pending, reject it, and verify status `rejected`.
7. Submit a fresh `close` request with `confirmation: "llm-validated"`; verify no confirmation dialog opens and the returned status/result matches the actual disposable worktree/session state.
8. Stop Spawnea and verify the bridge can no longer connect.
