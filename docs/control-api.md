# Spawnea local control API

Spawnea exposes a local control API so operators and terminal agents can create
sessions, inspect them, submit prompts, read turns, and request guarded
finalization. The supported client is the [`spawnea` CLI](cli.md); this document
describes the contract behind it.

There is no MCP server, stdio bridge, or network listener. The CLI talks to the
running desktop app over an owner-only Unix-domain socket.

## Compatibility

- MCP clients that used the removed `spawnea-mcp` helper cannot connect; use the
  `spawnea` CLI instead.
- The wire protocol is not backward compatible with the earlier MCP-based
  gateway. The CLI and the desktop app must come from the same build; restart the
  app after updating. `apiVersion: "v1"` names the result schema, not the
  transport.
- The persisted session creation source `mcp` is rewritten to `control` by
  migration `0010_rename_mcp_creation_source`. There is no reverse migration, so
  returning to an older build requires restoring a database backup.

## Runtime discovery and profiles

The desktop app writes a protected runtime descriptor and opens the socket under
`${XDG_RUNTIME_DIR}/spawnea/` (or `${XDG_RUNTIME_DIR}/spawnea/profiles/<profile>/`
for a named profile). The descriptor contains the socket path, the app PID, the
API version, and a random 256-bit token. Named profiles (`--profile <name>` or
`SPAWNEA_PROFILE`) keep their database, artifacts, logs, snippets, and control
socket separate from the default profile and from each other. Set
`SPAWNEA_CONTROL_RUNTIME_FILE` or pass `--runtime-file` only when a non-default
descriptor is required.

The gateway starts with the desktop app on Unix-like systems. It is disabled on
Windows until named-pipe transport is implemented. Set
`SPAWNEA_CONTROL_ENABLED=0` (or `false`, `off`, `no`, `disabled`) to disable it
elsewhere. Stopping the app removes the descriptor and socket; a detached
same-user watchdog removes them after an abrupt exit, but only while the
descriptor still names the exited PID.

## Wire protocol

After connecting, the client sends one authentication line, then newline-delimited
JSON requests. Each request is answered by one JSON line with the same `id`.

```json
{"type":"spawnea-auth","token":"<descriptor token>","sessionId":"<optional session id>"}
{"id":1,"method":"spawnea_list_sessions","params":{}}
{"id":1,"result":{"apiVersion":"v1","sessions":[]}}
{"id":2,"error":{"code":"not_found","message":"Session 'x' not found"}}
```

Error codes are `not_found`, `unauthorized`, `conflict`, `needs_human`,
`invalid_request`, and `operation_failed`. Requests are validated against strict
schemas before the control service can touch a host adapter, tmux, or Git, and a
request line is limited to 2 MiB. A line above the limit is answered with
`invalid_request` and `id: null`; requests already dispatched on that connection
still receive their replies (for up to 150 seconds), requests after the oversized
line are ignored, and the connection is then closed. All structured results include
`apiVersion: "v1"`.

## Connection scope

- **Operator connection** (no `sessionId`): used by the CLI from a normal
  terminal. It can discover the catalog, create independent root sessions, and
  manage children and sessions of the installation.
- **Session-scoped connection** (`sessionId`, injected into harnesses as
  `SPAWNEA_SESSION_ID`): the session must be an active local root, or a child
  that may act on itself. Requests targeting another root or an unrelated session
  are rejected as `unauthorized`. A scoped connection cannot create root
  sessions, and prompt delivery from it is restricted to direct children so a
  harness cannot write input into its own tmux pane while executing a command.
  Scope is revalidated on every operation. An empty `SPAWNEA_SESSION_ID` is an
  invalid identity and is rejected rather than treated as an operator connection.

Any process running as the same OS user can normally interact with that user's
files and desktop applications. The token and file permissions keep other users
and accidental unauthenticated connections out; they are not a sandbox against a
malicious process already running as the operator.

## Operations

Available to every connection:

| Operation | Purpose |
| --- | --- |
| `spawnea_list_sessions` | List sessions (a scoped connection sees its root and direct children, with `parentSessionId` and `childAlias`). |
| `spawnea_catalog` | Projects, harnesses, and hosts that can be launched. |
| `spawnea_status` | Detailed view of one session by ID, unique ID prefix, or name. |
| `spawnea_create_session` | Create one independent root session (operator connections only). |
| `spawnea_create_child_session` | Create a direct child under a parent session. |
| `spawnea_send_prompt` | Submit prompt text to a session or child terminal. |
| `spawnea_get_turn` | Read output produced after a prompt, with cursors and bounded long polling. |
| `spawnea_close_session` | Close a session; scoped connections close children. |
| `spawnea_get_state` | Full state: sessions, hosts, projects, harnesses, recent errors. |

Available only to session-scoped connections. These operations are part of the
socket contract but have no `spawnea` subcommands yet; they are reachable only
by a client that speaks the protocol above:

| Operation | Purpose |
| --- | --- |
| `spawnea_inspect_worktree` | Non-destructive managed-worktree inspection. |
| `spawnea_rename_session` | Change only the display title (1-120 characters). |
| `spawnea_activate` | Select a session and optionally a workspace tab in the live UI. |
| `spawnea_preflight_integration` | Predict merge conflicts for a local managed child without touching either checkout. |
| `spawnea_request_finalization` | Request guarded integrate or close of a child worktree. |
| `spawnea_get_finalization_request` | Query pending, executing, completed, rejected, or failed status. |
| `spawnea_close_shared_child` | Stop a same-project child while preserving shared files. |
| `spawnea_list_child_files`, `spawnea_read_child_file` | Bounded file listing and reading inside a child workspace. |
| `spawnea_get_child_git_status`, `spawnea_get_child_git_diff` | Bounded Git inspection of a child workspace. |
| `spawnea_list_child_artifacts` | Detected artifacts of a child session. |

### Root session creation

`spawnea_create_session` takes `projectId` and `task`, and optionally `agentId`,
`serverId`, `baseBranch`, `useWorktree`, `clientRequestId`, and `model`. IDs come
from `spawnea_catalog`. `task` becomes the recorded task and display name; it is
not typed into the harness terminal. Exact retries with the same
`clientRequestId` and input return the original session with `replayed: true`
and do not launch another tmux session or worktree; reusing an ID with different
input is a conflict. Request records live in memory for the lifetime of the
desktop process.

`model` is an exact requested model ID, validated for identifier syntax and
harness capability before resources are created. The native launch adapter maps
it to `-m` (Hermes, Codex) or `--model` (Claude), replacing any model flag in the
profile's own arguments. Capability belongs to the executable, so custom profile
IDs wrapping a supported executable work, while unknown wrapper executables are
rejected. The value records the requested choice; it is not an assertion about
the effective model or account access. Omission means the harness default and is
preserved as omission across restarts. Sessions created before this field existed
remain unrecorded and are shown as "Harness default / not recorded".

### Child creation

`spawnea_create_child_session` takes `parentSession`, `task`, and optionally
`name`, `workspace` (`same-project` or `new-worktree`), `agentId`, `serverId`,
`projectId`, `model`, `initialPrompt`, and `clientRequestId`. Without `agentId`,
the child inherits the parent's harness; an unavailable harness fails
explicitly and is never replaced silently. Children cannot create
grandchildren. A different-host child requires `serverId`, `projectId`, and
`workspace: "new-worktree"`. With `initialPrompt`, Spawnea waits a bounded time
for the session to leave `starting` and reports `promptStatus` and `turnId`
separately from creation success.

### Prompts and turns

`spawnea_send_prompt` waits briefly for a `starting` session, captures an initial
terminal cursor, and submits at most 32,000 characters through the PTY or tmux.
Known interactive editors receive bracketed paste followed by a separate Enter,
so callers must not send another key to submit. Delivery reports terminal writes,
not proof that the harness has started answering. A second unrelated prompt is
rejected while the turn is working; an answer is accepted after `needs_input`. If
text delivery succeeds but Enter cannot be confirmed, the response reports
`delivered: false` and `status: "unknown"`; do not resend the prompt.

`spawnea_get_turn` takes a `turnId` and returns bounded output after the initial
or supplied cursor, a replacement cursor, version, `truncated`, and
`cursorExpired`. `waitMs` is bounded to 30 seconds and wakes on output or when the
turn reaches `needs_input`, `completed`, or `failed`. A turn completes on a
response delimiter, an `idle` state rule, process exit, or a screen that stayed
unchanged for at least 30 seconds after producing output; a quiet screen that no
rule recognizes is otherwise reported as `unknown` (see [State Rules](state-rules.md)). `compact` output applies the
harness adapter's extraction; `raw` returns captured terminal output. Turns,
cursors, idempotency caches, and Agent Context records are volatile and are lost
when Spawnea restarts.

The desktop workspace includes a read-only **Agent Context** tab (`Alt+6`) with
the bounded calls made through scoped connections. It is never written as a
transcript and is reported unavailable after restart.

### Finalization

Integration always creates a pending request and waits for trusted UI approval.
Close requests must state `dirtyChanges` as `stash` or `discard`. A caller whose
agent has explicitly approved a close may add `"confirmation": "llm-validated"`;
for `stash` that selects `mode: "agent-validated"` and executes through the
existing `SessionManager.finishSession` guards without a dialog. `discard` always
requires the dialog, and the signal cannot authorize `integrate`. Only the
renderer preload can approve or reject pending requests. Results remain queryable
after the child is removed, and a pending request is never a success.

Close and integration refuse to proceed while another session on the same host
uses the worktree. A failed or inconclusive tmux termination check fails the
operation before merge, stash, discard, or worktree removal. Integration is
accepted only for a local managed-worktree child whose parent is local, and the
parent's branch must be checked out in the project's primary checkout.
When a managed worktree directory is already missing on disk, close with discard
completes safely without failing on missing paths, whereas stash is rejected.

## Plain shell harness

An explicit plain shell can be configured as a harness in `config.yaml`:

```yaml
hosts:
  local:
    name: Local Workstation
    enabled: true
    harnesses:
      shell:
        name: Interactive Shell
        command: bash
        args: []
        enabled: true
```

Spawnea also provides a default interactive shell (`<hostId>:shell`) for enabled
hosts when no custom shell entry is configured.

## Threat-model decisions

| Threat | Boundary / mitigation |
| --- | --- |
| Network exposure | Unix-domain socket only; no TCP/HTTP listener. |
| Integration not wanted | `SPAWNEA_CONTROL_ENABLED=0` disables the gateway. |
| Other local users | Owner-only runtime directory, socket, descriptor, and per-run random token. |
| Malformed or oversized input | Authentication line limit, request size limit, strict schemas. |
| Credential disclosure | Sanitized DTOs omit connection targets and all credential fields. |
| Reentrant root input | Scoped connections prompt direct children only. |
| Retry creates duplicates | Request IDs plus payload fingerprints; exact replay returns the original result. |
| Autonomous destructive Git | Integrate and unvalidated requests require trusted UI approval; validated close still passes the finalization guards. |
| Accidental dirty-work loss | Close requires an explicit `stash` or `discard` choice. |
| False success | Finalization status and the actual result or error remain queryable. |

## Manual smoke checklist

Use a disposable Git repository and a disposable Spawnea session.

1. Start Spawnea; run `spawnea catalog --json` and confirm no host addresses or credentials appear.
2. Create a root with `spawnea session create --project <id> --task "..." --no-worktree`; repeat the same request ID and confirm `replayed: true` and one session.
3. Create a child, send a prompt, and read the turn with `spawnea prompt wait`.
4. From inside the root harness (with `SPAWNEA_SESSION_ID`), confirm `spawnea list` shows only that root and its children and a root self-prompt is rejected.
5. Request a `close` with `dirtyChanges: "discard"` and no confirmation; confirm nothing is mutated while the dialog is pending, reject it, and check status `rejected`.
6. Request a `close` with `dirtyChanges: "stash"` and `confirmation: "llm-validated"`; confirm no dialog opens and the result matches the session state.
7. Stop Spawnea and verify `spawnea list` reports that the app is not running.
