# Spawnea Control CLI (`spawnea`)

The `spawnea` CLI is a fast, standalone command-line tool that communicates directly with Spawnea's local control domain socket. It enables operators and terminal AI agents (Codex, Hermes, Claude Code, AGY) to orchestrate sessions, create child sub-agents, submit prompts, and wait for results with atomic execution and standard UNIX exit codes.

Unlike complex persistent MCP stdio bridges that can drop connections unexpectedly, the `spawnea` CLI is atomic per command: connect, request, output response, and exit.

## Prerequisites

1. Spawnea desktop app is running on the local machine.
2. The CLI discovers the running instance via `${XDG_RUNTIME_DIR}/spawnea/control-runtime.json` (or `/run/user/<uid>/spawnea/control-runtime.json`).

## Commands

### `spawnea list [--json]`
Lists all active Spawnea sessions and their runtime states.

```bash
# Human-readable table:
spawnea list

# Raw JSON:
spawnea list --json
```

### `spawnea status <session-id> [--json]`
Inspects detailed metadata for a session, including worktree path, git branch, harness, and lifecycle status.

```bash
spawnea status sess-123
spawnea status sess-123 --json
```

### `spawnea session create --project <project-id> --task "<description>" [options]`
Creates a new independent root session.

Options:
- `--project <id>`: Target project ID (required)
- `--task "<description>"`: Task description (required)
- `--agent <id>`: Harness identifier (e.g. `codex`, `local:codex`)
- `--server <id>`: Host server (default: `local`)
- `--branch <branch>`: Base git branch
- `--no-worktree`: Do not create an isolated managed worktree

### `spawnea child create --parent <id> --task "<description>" [options]`
Creates an isolated child session under an existing root parent session.

Options:
- `--parent <id>`: Parent session ID (defaults to `$SPAWNEA_SESSION_ID` if set)
- `--task "<description>"`: Subtask description (required)
- `--agent <id>`: Harness identifier (defaults to parent's harness)
- `--workspace <type>`: `same-project` (shared directory) or `new-worktree` (isolated git worktree)
- `--name <title>`: Display title for the child session

```bash
# Create a child reviewer in the same working directory:
spawnea child create --parent root-1 --task "Review changes" --agent codex --workspace same-project

# Create a child in a new worktree:
spawnea child create --parent root-1 --task "Investigate bug" --workspace new-worktree
```

### `spawnea prompt send --session <id> "<prompt>"`
Submits text directly into the session's terminal.

```bash
spawnea prompt send --session child-1 "Run test suite and report results"
```

### `spawnea prompt wait --turn <turnId> [--timeout <sec>] [--json]`
Polls and waits for a turn to reach completion or require input.

```bash
spawnea prompt wait --turn "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" --timeout 120
```

### `spawnea prompt send-and-wait --session <id> "<prompt>" [--timeout <sec>] [--json]`
Convenience command that submits prompt text, monitors the turn until completion, and outputs the assistant's final response to stdout.

```bash
spawnea prompt send-and-wait --session child-1 "Run tests and summarize findings"
```

### `spawnea session close <session-id> [--force] [--json]`
Cleanly terminates and removes a session or child.

```bash
spawnea session close child-1
spawnea session close child-1 --force
```

### `spawnea skill prompt [--json]`
Generates a self-contained markdown instruction prompt explaining Spawnea CLI commands and workflows. Can be copied and pasted directly to any AI agent.

```bash
spawnea skill prompt
```

## Global Options

- `--profile <name>`: Target an isolated named Spawnea profile (or set `SPAWNEA_PROFILE=<name>`).
- `--runtime-file <path>`: Explicit path to `control-runtime.json`.
- `--json`: Format command output as machine-readable JSON.
- `-h, --help`: Show CLI help.
- `-v, --version`: Print version.
