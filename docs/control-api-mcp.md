# Spawnea local control API / MCP v1

Spawnea exposes a local, root-scoped MCP surface for inspecting sessions, creating direct children, submitting prompts, reading turns, and requesting guarded worktree finalization. It is enabled by default on Unix-like systems and does not open an HTTP or network port. Windows support is deferred until named-pipe transport is implemented.

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

The bridge finds the active desktop process through `${XDG_RUNTIME_DIR}/spawnea/control-runtime.json`. On Linux it also checks `/run/user/<uid>/spawnea/control-runtime.json` so harnesses launched through tmux still connect when that shell does not inherit `XDG_RUNTIME_DIR`; the private temporary-directory location remains a fallback. Set `SPAWNEA_CONTROL_RUNTIME_FILE` in both processes only when a non-default runtime file is required. Stop the desktop app to disable the integration; without an active app, the bridge exits because its owner socket closes. Set `SPAWNEA_CONTROL_ENABLED=0`, `false`, `off`, `no`, or `disabled` only when the local MCP socket should be disabled intentionally. The integration is currently disabled on Windows because named-pipe transport is not implemented yet.

The v1 bridge exposes only the canonical `spawnea_*` tools documented below. The bridge sends `spawnea-auth` with the injected `SPAWNEA_SESSION_ID`. Children receive their own identity and cannot authenticate as an orchestrating root. Existing connections are revalidated on each operation.

The desktop workspace includes a read-only **Agent Context** tab (`Alt+6`). It shows bounded calls made through the scoped MCP connection, groups consecutive unchanged turn polls, and exposes request/response and cursor metadata in a detail pane. This volatile context is never written as a transcript and is reported unavailable after restart.

Child close requests accept a `sessionId` and optional `force`; `force: true` is required for a `working` or `starting` child. The shared-child close operation preserves shared workspace files. Managed-worktree finalization follows its guarded integration or close policy. Integration is accepted only for a local managed worktree child whose parent is local; remote children remain inspectable but cannot be integrated automatically.

## Transport and authorization boundary

- The MCP client communicates with a dedicated stdio bridge. Protocol output is written only to stdout; diagnostics go to stderr.
- The bridge connects to a Unix-domain socket owned by the current OS user. The runtime directory is mode `0700`; the socket and ephemeral-token descriptor are mode `0600`.
- A detached same-user watchdog removes the descriptor and socket after abrupt Electron termination, but only while the protected descriptor still names the exited Electron PID.
- The gateway starts by default with the desktop app on Unix-like systems. It is disabled on Windows until named-pipe transport is implemented. Set `SPAWNEA_CONTROL_ENABLED=0` (or `false`, `off`, `no`, `disabled`) to disable it elsewhere. There is no TCP listener, public API, remote daemon, or remote host installation.
- Every socket connection must authenticate with the random 256-bit token from the protected runtime descriptor and an active root session ID before MCP messages are accepted. The gateway rejects unknown IDs, child IDs, and roots that are not local.
- Spawnea persists a new root session's scoped identity before launching its harness. If tmux startup fails, that persistence is rolled back. Authentication also rechecks the same identity during the existing three-second window, then rejects it if the root never becomes active.
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

### `spawnea_preflight_integration`

Input: `{ "sessionId": "child-session-id" }`. Checks an eligible local managed child and returns `parentBranch`, `baseCommit`, bounded `parentCommits`, `hasConflicts`, `conflictingFiles`, and `truncated`. `hasConflicts` is authoritative: some Git conflicts have no individual file paths. Git's `merge-tree --write-tree` predicts conflicts without updating either checkout, index, or branch ref; it may write unreachable Git objects. Unsupported Git versions fail explicitly. Finalization repeats preflight before stopping the child. Current managed finalization requires the parent's branch to be checked out in the project's primary checkout.

Batch creation is not exposed. Use `spawnea_create_child_session` once per child.

### `spawnea_close_shared_child`

Input: `{ "sessionId": "same-project-child-id", "force": true }`. Stops and removes a direct same-project child without deleting shared workspace files. `force` is required for a working or starting child. Managed worktree children use guarded finalization. The result includes `removed` and `workspacePreserved`.

### `spawnea_activate`

Input: `{ "sessionId": "session-id", "tab": "terminal|files|diff|artifacts|details|agent-context" }`. Selects a known session/tab in the live renderer. It does not run host or Git commands. The result says whether delivery to a live renderer occurred.

### `spawnea_request_finalization`

Requests guarded worktree finalization. Integrate always creates a pending request and waits for trusted renderer approval. Close requests must include `dirtyChanges` set to `stash` or `discard`.

When the MCP caller's LLM has explicitly approved the close, it must also send:

```json
{ "confirmation": "llm-validated" }
```

For `dirtyChanges: "stash"`, that signal selects `mode: "mcp-validated"`. Spawnea executes the close through the existing `SessionManager.finishSession` safety path. Discard always selects `ui-confirmation`, even if the caller supplies LLM validation. Results remain queryable by the requesting root after successful child removal.

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

`dirtyChanges` must be `stash` or `discard`. Discard is permanent and requires the human confirmation dialog. Only the renderer preload exposes approval/rejection for pending requests.

Close and integration refuse to proceed while another session on the same host
uses the worktree, including same-project children and promoted root sessions.
Close those sessions before retrying; changing hierarchy alone does not change
their working directory. Children with independent worktrees remain running and
are promoted to roots after successful finalization. Ordinary session deletion
with `leave-children` preserves a shared worktree and transfers managed ownership
to a surviving session.

Removal and unadoption wait up to 30 seconds for in-progress child creation to finish or roll
back; shutdown cancels this wait. Timeout or cancellation returns an error without
starting cleanup. The lifecycle guard remains until every active creation settles,
rejecting new children and concurrent removal attempts. Retry after creation
completes or rolls back.
A failed or inconclusive tmux termination check fails the operation before merge,
stash, discard, or worktree removal. An explicitly verified absent tmux session is
safe to finalize. Retries recheck workspace use and termination, skip only cleanup
steps recorded as complete, and report failure if remaining cleanup fails. These
failures appear in the desktop dialog and in the queryable MCP request result.
Authorization is unchanged: integration requires UI approval; close may use UI
approval or explicit LLM validation.

### `spawnea_get_finalization_request`

Input: `{ "requestId": "uuid-returned-above" }`. Returns one of `pending`, `executing`, `completed`, `rejected`, or `failed`, plus the truthful result/error. Clients must not interpret a pending request as success.

### `spawnea_create_child_session`

Input:
```json
{
  "clientRequestId": "review-child-1",
  "parentSession": "parent-session-id",
  "name": "Investigate unit test regression",
  "serverId": "local",
  "projectId": "spawnea",
  "model": "gpt-5",
  "task": "Investigate regression in test suite",
  "workspace": "same-project",
  "agentId": "agent-id",
  "initialPrompt": "Review the current changes"
}
```

Creates a direct child session under an existing root parent session. Optional `serverId`, `projectId`, and `model` default to the parent server, project, and harness configuration. `model` must use the supported model identifier format. A different-host child requires both `serverId` and `projectId` plus `workspace: "new-worktree"`; invalid combinations are rejected. `workspace` must be either `"same-project"` (runs directly in parent's working directory) or `"new-worktree"` (creates an isolated managed git worktree). Enforces a strict 2-level cap: child sessions cannot spawn grandchildren. An optional `clientRequestId` makes exact retries idempotent. When `initialPrompt` is present, Spawnea waits for the session to leave `starting` for a bounded period and reports `promptStatus`, `turnId`, and any prompt error separately from successful session creation.

### `spawnea_list_sessions`

Input: `{}` (no arguments).

Returns the authenticated root and its direct children, including `parentSessionId` and `childAlias`.

### `spawnea_send_prompt`

Input:
```json
{
  "target": "session-id-or-child-alias",
  "parentSession": "parent-session-id",
  "clientRequestId": "review-turn-1",
  "prompt": "Run the test suite and report results"
}
```

Use a direct child's session ID or alias. Aliases resolve inside the authenticated root automatically. Optional `parentSession` must match that root. Self-prompts and cross-tree prompts are rejected.

Waits for a `starting` session to become usable for a bounded period, captures an initial terminal cursor, and submits at most 32,000 characters through the PTY or tmux. Known interactive editors receive bracketed paste, followed by a separate Enter after 500 ms. The caller must not send another prompt or key to submit the text. Delivery reports terminal writes, not proof that the harness has started answering. The result contains `turnId`, `version`, and delivery metadata. Exact `clientRequestId` retries do not submit twice. A second unrelated prompt is rejected while the turn is working; an answer is accepted after `needs_input`.

If text delivery succeeds but Enter cannot be confirmed, the response has `delivered: false`, `status: "unknown"`, and recovery instructions. The turn and request ID remain retained: exact retries return that result without writing again, and new prompts are blocked until the uncertain session is resolved. Do not resend the prompt as a recovery action.

Agent Context allows explicit compact/raw turn selection. It reads the last retained snapshot without polling the live terminal or advancing turn state. Its bounded output is redacted and activity is labeled best-effort. Finished turns retain their last output rather than absorbing later terminal activity.

### `spawnea_get_turn`

Input:
```json
{
  "turnId": "uuid-returned-by-send-prompt",
  "cursor": "opaque-cursor-from-prior-read",
  "afterVersion": 2,
  "waitMs": 30000,
  "outputMode": "compact",
  "maxBytes": 32768
}
```

Reads output produced after the prompt's initial cursor or after the supplied cursor. `waitMs` is bounded to 30 seconds and wakes when the turn changes or reaches `needs_input`, `completed`, or `failed`. The result always includes a replacement cursor, version, `truncated`, and `cursorExpired`. `compact` is the default and applies the selected harness adapter's bounded output extraction, returning any reported omissions in the `omitted` result field. `raw` returns the bounded captured terminal output without filtering. Turn state and cursors are volatile and disappear when Spawnea restarts.

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
4. Call `spawnea_create_child_session`, then retry the exact request with the same `clientRequestId`; confirm `replayed: true` and no duplicate child.
5. Create a disposable child with `initialPrompt`; call `spawnea_get_turn` using `afterVersion` and `waitMs`, then continue from the returned cursor. Confirm questions wake with `needs_input` and an answer can be submitted on the same turn.
6. Call `spawnea_activate` and `spawnea_inspect_worktree`; confirm the selected tab changes and the repository remains unchanged.
7. Request `close` with `dirtyChanges: "discard"` and no confirmation; confirm no Git/tmux mutation occurs while the dialog is pending, reject it, and verify status `rejected`.
8. Submit a fresh `close` request with `dirtyChanges: "stash"` and `confirmation: "llm-validated"`; verify no confirmation dialog opens and the returned status/result matches the disposable worktree/session state. Confirm discard still requires the dialog.
9. Stop Spawnea and verify the bridge can no longer connect.
