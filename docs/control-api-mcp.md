# Spawnea local control API / MCP v1

Spawnea exposes a local MCP surface for inspecting sessions, renaming session display titles, creating session batches, navigating the desktop UI, and requesting guarded worktree finalization. It is enabled by default on Unix-like systems and does not open an HTTP or network port. Windows support is deferred until named-pipe transport is implemented.

## Enable and connect

1. Build and package Spawnea with `pnpm package:desktop:host`.
2. Start the installed desktop app.
3. Configure the MCP client to launch the installed stdio bridge helper:

```json
{
  "mcpServers": {
    "spawnea": {
      "command": "/Applications/Spawnea.app/Contents/Resources/spawnea-mcp",
      "args": []
    }
  }
}
```

The packaged application starts the bridge in a dedicated MCP mode; Node.js and
a Spawnea source checkout are not required. Supported launch paths are:

- macOS: `/Applications/Spawnea.app/Contents/Resources/spawnea-mcp`
- Linux AppImage: use the absolute AppImage path as `command` and pass
  `--spawnea-mcp` as its only initial argument. Directory-style Linux packages
  expose the equivalent helper at `resources/spawnea-mcp`.
- Windows: MCP control is not currently available.

For example, an AppImage configuration is:

```json
{
  "mcpServers": {
    "spawnea": {
      "command": "/absolute/path/to/Spawnea-0.1.0-linux-x86_64.AppImage",
      "args": ["--spawnea-mcp"]
    }
  }
}
```

The macOS example uses the default install location. If Spawnea is installed
elsewhere, replace only the helper path. On Unix-like systems, ensure the helper
or AppImage is executable.

The bridge finds the active desktop process through `${XDG_RUNTIME_DIR}/spawnea/control-runtime.json`. Set `SPAWNEA_CONTROL_RUNTIME_FILE` in both processes only when a non-default runtime file is required. Stop the desktop app to disable the integration; without an active app, the bridge exits because its owner socket closes. Set `SPAWNEA_CONTROL_ENABLED=0`, `false`, `off`, `no`, or `disabled` only when the local MCP socket should be disabled intentionally. The integration is currently disabled on Windows because named-pipe transport is not implemented yet.

The v1 bridge exposes only the canonical `spawnea_*` tools documented below; no legacy MCP tool aliases are currently registered. `SPAWNEA_CONTROL_*` environment variables remain fallbacks, the legacy runtime descriptor location is discovered by the bridge, and both local authentication message names are accepted. New integrations should use the canonical Spawnea names.

## Transport and authorization boundary

- The MCP client communicates with a dedicated stdio bridge. Protocol output is written only to stdout; diagnostics go to stderr.
- The bridge connects to a Unix-domain socket owned by the current OS user. The runtime directory is mode `0700`; the socket and ephemeral-token descriptor are mode `0600`.
- A detached same-user watchdog removes the descriptor and socket after abrupt Electron termination, but only while the protected descriptor still names the exited Electron PID.
- The gateway starts by default with the desktop app on Unix-like systems. It is disabled on Windows until named-pipe transport is implemented. Set `SPAWNEA_CONTROL_ENABLED=0` (or `false`, `off`, `no`, `disabled`) to disable it elsewhere. There is no TCP listener, public API, remote daemon, or remote host installation.
- Every socket connection must authenticate with the random 256-bit token from the protected runtime descriptor and an active root session ID before MCP messages are accepted. The gateway rejects unknown IDs, child IDs, and roots that are not local.
- After authentication, the MCP server is scoped to the authenticated root and its direct child sessions. Requests targeting another root or an unrelated session are rejected.
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

### `spawnea_create_child_session`

Input:
```json
{
  "parentSession": "parent-session-id",
  "name": "Investigate unit test regression",
  "task": "Investigate regression in test suite",
  "workspace": "same-project",
  "agentId": "agent-id"
}
```

Creates a direct child session under an existing root parent session. Server, project, and default agent harness are inherited from the parent session. `workspace` must be either `"same-project"` (runs directly in parent's working directory) or `"new-worktree"` (creates an isolated managed git worktree). Enforces a strict 2-level cap: child sessions cannot spawn grandchildren. Returns the allocated monotonic child alias (`child-1`, `child-2`, etc.), parent session ID, and session status (`starting`).

### `spawnea_list_sessions`

Input: `{}` (no arguments).

Returns canonical listing of all sessions with full hierarchy metadata, including `parentSessionId` and `childAlias`.

### `spawnea_send_prompt`

Input:
```json
{
  "target": "session-id-or-child-alias",
  "parentSession": "parent-session-id",
  "prompt": "Run the test suite and report results"
}
```

Canonical session IDs always work. A `child-*` alias must include
`parentSession` when it is not globally unique; ambiguous aliases are rejected
without that scope.

Writes prompt text directly to the target session's active PTY stream or underlying tmux session. Returns immediately after delivering prompt input without waiting for agent completion.

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
