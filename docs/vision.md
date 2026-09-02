# Vision

## Mission

Spawnea is a desktop workspace for supervising and interacting with multiple AI coding agents running locally or on remote machines.

It is not a replacement for a code editor. It is an operational IDE for agents.

## Core model

A session binds together:

```text
Server + Project + Agent + Task + Worktree + tmux session
```

The selected session defines the entire UI context:

- terminal;
- project;
- server;
- agent/harness;
- worktree and branch;
- files;
- Git changes;
- artifacts;
- attention state.

## Principles

### tmux-first

Long-running agents live in tmux. Closing Spawnea must not kill them.

### SSH-first

Remote Linux machines are accessed through standard SSH/SFTP. The MVP should not require a custom server daemon.

### Zero Required Remote Installation

Spawnea must operate on remote hosts without installing Spawnea software, background daemons, packages, plugins, hooks, or global configuration modifications (`~/.codex/`, `~/.claude/`, `~/.config/opencode/`, shell rc files, `/etc/`). For a host already reachable over SSH, Spawnea-managed sessions require only the standard `tmux` command on the target; the configured agent command and its dependencies remain user-managed. Spawnea uses standard SSH, tmux, and POSIX utilities plus non-invasive inspections such as `tmux capture-pane`. No resident Spawnea process runs on the remote host.

### Output-driven state detection

Session attention state is inferred from observable runtime state and terminal output. Hermes status detection reads the tmux terminal tail, parses rendered prompts and responses, and maps them to normalized states. Hermes hooks, event files, and helper processes are not required by the base runtime.

### Terminal privacy boundary

The terminal view uses the open-source `@xterm/xterm` library, with `node-pty` and `ssh2` for PTY and SSH transport. Spawnea streams terminal bytes to the UI but does not record a terminal transcript or upload terminal data to a Spawnea service. Local operational metadata, logs, artifacts, and explicitly requested diagnostic reports remain separate persistence features.

The terminal accepts OSC 52 clipboard writes so copy mode works through SSH and
nested tmux sessions. Spawnea decodes at most 1 MiB of UTF-8 text and writes it
through the context-isolated Electron clipboard bridge. Clipboard read queries
from terminal applications are consumed without exposing local clipboard data.

### Native workspace isolation

Each session operates in its configured project folder or native Git worktree, keeping agent environments cleanly separated without third-party toolchains.

### Harness-agnostic

Codex, Claude Code, Hermes, OpenCode, arbitrary CLI agents, and a normal shell are all launch configurations behind the same session model.

### Remote should feel local

Clipboard, file browsing, Git state, terminal interaction, and artifact previews should work similarly whether the session is local or remote.

### Attention is a first-class feature

The application should quickly answer: **which session needs me now?**

Initial states:

```text
starting
working
needs_input
idle
done
error
disconnected
```

## MVP

The MVP is useful when a user can:

1. register several SSH servers;
2. register projects and their root folders;
3. register multiple agent commands;
4. create a project/task/agent session;
5. create or attach its tmux workspace;
6. interact through an integrated terminal;
7. close and reopen Spawnea without losing the agent;
8. reconnect to running sessions;
9. see which sessions are working, waiting, done, or failed;
10. browse the active worktree;
11. inspect Git changes;
12. paste or drag a file/image into the active remote session;
13. see session input/output artifacts;
14. preview common artifacts generated remotely.

## Non-goals for the first MVP

- full code editor or LSP;
- debugger;
- multi-user collaboration;
- SaaS backend;
- GitHub/issue tracker integration;
- cloud sync;
- agent-to-agent orchestration;
- cost accounting;
- plugin marketplace.
