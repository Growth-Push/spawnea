# Spawnea local control API / MCP v1

Spawnea exposes a local MCP surface for creating or attaching to one root session, inspecting that root and its direct children, submitting prompts, reading turns, and requesting guarded worktree finalization. It is enabled by default on Unix-like systems and does not open an HTTP or network port. Windows support is deferred until named-pipe transport is implemented.

Bootstrap mode is available only when `SPAWNEA_SESSION_ID` is absent. A defined
but empty value is rejected. Root-creation retry records live for the lifetime
of the running desktop process and are not restored after Spawnea restarts.

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

The v1 bridge exposes only the canonical `spawnea_*` tools documented below. When `SPAWNEA_SESSION_ID` is present, the bridge sends it with `spawnea-auth` and the connection opens directly in that active local root's scope. Children receive their own identity and cannot authenticate as an orchestrating root. Existing scoped connections are revalidated on each operation.

When `SPAWNEA_SESSION_ID` is absent, the bridge authenticates with the runtime token only and opens in bootstrap mode. A defined but empty `SPAWNEA_SESSION_ID` is an invalid identity and is rejected instead of opening bootstrap. Bootstrap exposes only `spawnea_get_state` and `spawnea_create_session`. Its state contains enabled local hosts and their enabled catalog projects and harnesses; disabled catalog entries are neither offered nor accepted. Seed projects and agents that do not originate from the catalog remain available as fallbacks. Bootstrap does not expose existing sessions, SSH-backed loopback targets, or remote targets. Creating a root binds that socket permanently to the new root and adds the scoped tools to the same MCP connection. Exact concurrent retries share the creation attempt. If the socket is lost, a replacement token-only connection can repeat the same `clientRequestId` and payload to bind to the existing root instead of creating another. Successful request IDs remain idempotent for the lifetime of the desktop process. An exact retry after a creation failure may try again. After Spawnea has created a root, a binding failure retains that root identity so a retry binds to it instead of creating another. A different creation request on the same socket is rejected.

The `task` supplied to `spawnea_create_session` becomes the root session's recorded task and display name and is available through its session context. It is not typed into the new harness as a terminal prompt. The bootstrap-bound connection may call `spawnea_send_prompt` with the returned `rootSessionId` as `target`. A connection authenticated with that root harness's injected `SPAWNEA_SESSION_ID` remains child-only for prompt and turn operations, preventing the harness from feeding terminal input into itself.

The desktop workspace includes a read-only **Agent Context** tab (`Alt+6`). It shows bounded calls made through the scoped MCP connection, groups consecutive unchanged turn polls, and exposes request/response and cursor metadata in a detail pane. This volatile context is never written as a transcript and is reported unavailable after restart.

Child close requests accept a `sessionId` and optional `force`; `force: true` is required for a `working` or `starting` child. The shared-child close operation preserves shared workspace files. Managed-worktree finalization follows its guarded integration or close policy. Integration is accepted only for a local managed worktree child whose parent is local; remote children remain inspectable but cannot be integrated automatically.

## Transport and authorization boundary

- The MCP client communicates with a dedicated stdio bridge. Protocol output is written only to stdout; diagnostics go to stderr.
- The bridge connects to a Unix-domain socket owned by the current OS user. The runtime directory is mode `0700`; the socket and ephemeral-token descriptor are mode `0600`.
- A detached same-user watchdog removes the descriptor and socket after abrupt Electron termination, but only while the protected descriptor still names the exited Electron PID.
- The gateway starts by default with the desktop app on Unix-like systems. It is disabled on Windows until named-pipe transport is implemented. Set `SPAWNEA_CONTROL_ENABLED=0` (or `false`, `off`, `no`, `disabled`) to disable it elsewhere. There is no TCP listener, public API, remote daemon, or remote host installation.
- Every socket connection must authenticate with the random 256-bit token from the protected runtime descriptor. A connection that supplies a session ID must name an active local root; the gateway rejects unknown IDs, child IDs, and non-local roots. A connection without a session ID receives only the local bootstrap surface until it creates and binds one root.
- Spawnea persists a new root session's scoped identity before launching its harness. If tmux startup fails, that persistence is rolled back. Authentication also rechecks the same identity during the existing three-second window, then rejects it if the root never becomes active.
- After authentication, the MCP server is scoped to the authenticated root and its direct child sessions. Requests targeting another root or an unrelated session are rejected. Prompt delivery from this injected-identity connection is restricted to direct children; it cannot target the root harness that is executing the tool call.
- After bootstrap root creation, the same boundary is pinned to the created root for the lifetime of that connection. Bootstrap is one-root: `spawnea_create_session` remains callable only for an exact replay of the binding request and cannot create or select another root.
- The connection retains its origin after binding. Only an absent-ID bootstrap-bound connection may deliver prompts to its root. Exact replay on a replacement absent-ID connection restores that bootstrap-bound origin; supplying the returned root as `SPAWNEA_SESSION_ID` creates an injected-identity connection and therefore does not grant root prompt delivery.
- The read model returns host IDs and display names, never SSH targets, usernames, passwords, tokens, secret references, or resolved credentials.
- Zod schemas reject malformed tool input before the control service can call a host adapter, tmux, or Git.

Any process running as the same OS user can normally read that user's files and interact with that user's desktop applications. The token and file permissions prevent access from other users and accidental unauthenticated connections; they are not a sandbox against a malicious process already running as the operator.

## Connection lifecycle

- With `SPAWNEA_SESSION_ID`, the connection starts root-scoped after the gateway validates an enabled, active root. Its prompt-delivery scope contains direct children only.
- Without `SPAWNEA_SESSION_ID`, the connection starts in restricted bootstrap mode and becomes bootstrap-bound after `spawnea_create_session` succeeds or exactly replays a successful creation from another connection to the same running desktop process. Its prompt-delivery scope contains the root and its direct children.
- Root creation starts the same persistent tmux-backed session lifecycle used by the renderer. Closing the MCP client or Spawnea does not terminate that tmux session.
- Tracked turns, cursors, idempotency caches, bootstrap creation records, and Agent Context records are volatile. They disappear when Spawnea restarts.
- A replacement connection may authenticate with the returned root ID. If the creation response was lost while the same desktop process is running, it may omit `SPAWNEA_SESSION_ID` and repeat the exact `spawnea_create_session` request. A successful replay binds the replacement connection to the recorded root before returning it. Restarting Spawnea clears this recovery record.

## Tools

All structured responses include `apiVersion: "v1"` where the response is owned by Spawnea.

### `spawnea_create_session`

Creates one new independent/root Spawnea session. It is available in bootstrap
mode and remains registered after scope binding solely for exact replay of the
request that established that scope. It does not adopt an arbitrary existing
session and does not create a child.

Input:

```json
{
  "clientRequestId": "root-bootstrap-1",
  "serverId": "local",
  "projectId": "spawnea",
  "agentId": "codex",
  "task": "Coordinate the documentation update",
  "baseBranch": "main",
  "useWorktree": true
}
```

`clientRequestId`, `serverId`, `projectId`, `agentId`, and `task` are required.
`baseBranch` and `useWorktree` use the existing root-session creation inputs and
are optional. IDs must come from bootstrap discovery rather than from the normal
root-scoped state of another connection.

The successful output contains `apiVersion`, `replayed`, and the
sanitized created `session` view, including its ID, status, host/project/harness
display identities, and worktree metadata. Success also means the current MCP
connection has transitioned to that session's root scope; a response must not
report success before both creation and scope binding have completed.

Exact retries with the same `clientRequestId` and identical input
must return the original session with `replayed: true` and must not launch a
second tmux session or create a second worktree. This replay is accepted both on
the connection already bound by that request and on a replacement bootstrap
connection while the same desktop process remains active. On a replacement
connection, Spawnea finds the in-memory request record, binds the connection to
that root, and only then returns the replayed result. A
root-scoped connection rejects every other creation request, including a new
`clientRequestId`; it cannot use this replay path to switch roots.

Bootstrap idempotency is shared across connections to the running desktop
process. Concurrent exact requests share one creation attempt. Successful
request IDs and their full normalized-input fingerprints remain in memory for
the process lifetime; reusing an ID with different input returns a conflict. A
failed creation is removed from the cache so an exact later retry may try again.
Restarting Spawnea clears these records.

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

### `spawnea_create_session` (bootstrap only)

Input:

```json
{
  "clientRequestId": "create-root-1",
  "serverId": "local",
  "projectId": "spawnea",
  "agentId": "codex",
  "task": "Review the bootstrap flow",
  "baseBranch": "main",
  "useWorktree": true
}
```

Creates one independent root on an enabled local host and binds the bootstrap MCP connection to it. `baseBranch` and `useWorktree` are optional. Before creation, `spawnea_get_state` returns only bootstrap choices. After binding, it returns the new root and its direct children, and the full scoped tool set is available. `clientRequestId` plus the complete request payload defines an installation-wide idempotent retry for the running desktop process, including a replacement bootstrap connection after transport loss. A bound connection cannot create or bind a different root later. The `task` records root context but is not automatically submitted to the harness terminal.

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

Use a direct child's session ID or alias from any root-scoped connection. An
external connection that omitted `SPAWNEA_SESSION_ID` and became bootstrap-bound
by creating or exactly replaying the root may also use that root's session ID.
The connection origin is part of the authorization decision and remains fixed
after binding. A connection authenticated with the root harness's injected
identity cannot prompt the root, because doing so would write bracketed input and
Enter into the same tmux pane while that harness is executing this tool call.
Aliases resolve inside the scoped root automatically. Optional `parentSession`
must match that root. Unrelated roots, unrelated children, and grandchildren are
rejected. Root creation does not submit the recorded `task` automatically.

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

Reads output produced after the prompt's initial cursor or after the supplied cursor for a tracked turn owned by either the scoped root or one of its direct children. The caller supplies a `turnId`, not a session ID; Spawnea resolves the owning session and enforces the scope before reading. `waitMs` is bounded to 30 seconds and wakes when the turn changes or reaches `needs_input`, `completed`, or `failed`. The result always includes the owning `sessionId`, a replacement cursor, version, `truncated`, and `cursorExpired`. `compact` is the default and applies the selected harness adapter's bounded output extraction, returning any reported omissions in the `omitted` result field. `raw` returns the bounded captured terminal output without filtering. Turn state and cursors are volatile and disappear when Spawnea restarts.

## Concise bootstrap flow

1. Start Spawnea and launch the stdio helper without `SPAWNEA_SESSION_ID`.
2. Call `spawnea_get_state` to obtain eligible host, project, and harness IDs.
3. Call `spawnea_create_session` with a stable `clientRequestId` and one discovered configuration.
4. Retain the returned root session ID. The same MCP connection is now scoped to that root. If the response is lost, open a replacement helper without `SPAWNEA_SESSION_ID` and repeat the identical request; its replay binds the replacement connection to the original root.
5. Call `spawnea_send_prompt` with the root ID, and read its returned `turnId` with `spawnea_get_turn`.
6. Create direct children as needed. This bootstrap-bound connection may deliver prompts to the root or those direct children, while unrelated roots remain inaccessible. A later connection using `SPAWNEA_SESSION_ID` remains limited to direct-child prompt delivery.

## Threat-model decisions

| Threat | Boundary / mitigation |
| --- | --- |
| Network exposure | Unix-domain socket only; no TCP/HTTP listener. |
| Integration not wanted | Explicit `SPAWNEA_CONTROL_ENABLED=0`/`false`/`off`/`no`/`disabled` disables the local gateway. |
| Other local users | Owner-only runtime directory, socket, descriptor, and per-run random token. |
| Malformed or oversized input | Authentication line limit, MCP transport buffer limit, strict schemas and batch limit. |
| Credential disclosure | Sanitized control DTOs omit connection targets and all credential fields. |
| Reentrant root input | Root prompt delivery requires an immutable absent-ID bootstrap origin. Connections authenticated with the root harness's injected identity can prompt direct children only. |
| Retry creates duplicates | Existing child and batch flows use request/correlation IDs plus payload fingerprints. Root bootstrap shares in-flight work and retains successful request fingerprints and results for the lifetime of the desktop process, allowing exact replay from the same or a replacement connection without creating another root. |
| Ambiguous batch failure | One success/error result per `clientRequestId`. |
| Autonomous destructive Git | Integrate and unvalidated MCP requests require trusted UI approval. A close may execute without the dialog only when the authenticated MCP request carries the explicit `llm-validated` protocol signal; the existing finalization guards still decide whether it can mutate anything. |
| Accidental dirty-work loss | Close requires an explicit `stash` or `discard` choice; UI-confirmation requests repeat it in the dialog, while validated MCP closes carry it in the authenticated request. |
| False success | Finalization status and actual `FinishSessionResult`/error remain queryable. |

## Manual smoke checklist

Use a disposable Git repository and a disposable Spawnea managed-worktree session.

1. Start Spawnea and connect an MCP client without `SPAWNEA_SESSION_ID`; confirm only `spawnea_get_state` and `spawnea_create_session` are exposed and bootstrap state omits existing sessions, remote targets, host addresses, and credentials.
2. Call `spawnea_create_session`, retry the exact request on the same connection and on a replacement token-only connection, and confirm one root is created and both sockets bind only to it. Confirm a different root request is rejected and the task is recorded without being typed into the harness terminal.
3. Prompt the root from the bootstrap-bound connection. Reconnect from the created root with its injected `SPAWNEA_SESSION_ID`; confirm the scoped tools are exposed, `spawnea_get_state` contains only that root and its direct children, and a root self-prompt is rejected.
4. Call `spawnea_rename_session`; confirm the context bar/sidebar update, `spawnea_get_state` returns the new title, and the task/tmux/branch/worktree fields are unchanged.
5. Call `spawnea_create_child_session`, then retry the exact request with the same `clientRequestId`; confirm `replayed: true` and no duplicate child.
6. Create a disposable child with `initialPrompt`; call `spawnea_get_turn` using `afterVersion` and `waitMs`, then continue from the returned cursor. Confirm questions wake with `needs_input` and an answer can be submitted on the same turn.
7. Call `spawnea_activate` and `spawnea_inspect_worktree`; confirm the selected tab changes and the repository remains unchanged.
8. Request `close` with `dirtyChanges: "discard"` and no confirmation; confirm no Git/tmux mutation occurs while the dialog is pending, reject it, and verify status `rejected`.
9. Submit a fresh `close` request with `dirtyChanges: "stash"` and `confirmation: "llm-validated"`; verify no confirmation dialog opens and the returned status/result matches the disposable worktree/session state. Confirm discard still requires the dialog.
10. Stop Spawnea and verify the bridge can no longer connect.
