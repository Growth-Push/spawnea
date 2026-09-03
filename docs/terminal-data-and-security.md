# Terminal Data Flow and Security Boundaries

Spawnea connects developers to terminal-based coding agents running locally or over SSH. This document details how terminal bytes flow through the application, how agent status is detected, and what data is (and is not) retained.

---

## Component Architecture

The terminal subsystem isolates presentation, IPC, and execution across clear layer boundaries:

```mermaid
flowchart LR
    subgraph UI [Electron Renderer]
        XTERM[@xterm/xterm]
    end
    subgraph Main [Electron Main Process]
        PTY[PTY Stream Broker]
        DET[State Detector Engine]
    end
    subgraph Target [Local or Remote Host]
        TMUX[tmux Session]
    end

    XTERM <-->|Typed IPC| PTY
    PTY <-->|PTY / SSH2 Stream| TMUX
    TMUX -.->|In-Memory capture-pane Tail| DET
```

1. **Terminal View**: The user interface renders terminal output using the open-source [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) component, styled for readability and dynamically sized via `@xterm/addon-fit`.
2. **PTY Bridge**: Local terminal processes attach through `node-pty` in the Electron Main process.
3. **SSH Transport**: Remote sessions stream PTY data over SSH channels using [`ssh2`](https://github.com/mscdex/ssh2).
4. **Window Resizing**: Dimension changes in `@xterm/xterm` are passed over IPC to the Main process, which sends `SIGWINCH` or tmux resize commands to keep the terminal buffer in sync.

---

## Clipboard and OSC 52 Handling

Spawnea supports the standard **OSC 52** terminal escape sequence for clipboard integration across local and remote sessions:

- When an agent or CLI application (such as tmux or vim) issues an OSC 52 write sequence, Spawnea decodes the base64-encoded UTF-8 text (up to a bounded limit of 1 MiB) and updates the local system clipboard via Electron's context-isolated clipboard API.
- Spawnea intentionally ignores OSC 52 clipboard read queries from terminal applications to prevent remote shell processes from reading local clipboard contents without consent.

---

## Output-Driven State Detection

A core feature of Spawnea is knowing which agent needs attention (e.g., waiting for input, working, or done) across dozens of parallel sessions.

Rather than installing proprietary daemons, event hooks, or background webhooks on target machines, Spawnea relies on **observable runtime output**:

1. **Transient Activity Metrics**: The PTY stream records lightweight activity timestamps (`lastOutputAt`, `lastInputAt`) and recent byte rates to detect active output streaming.
2. **Pane Inspection**: Spawnea periodically queries tmux for foreground process state (`tmux list-panes` format fields: PID, current command, dead/alive flag).
3. **Bounded Tail Inspection**: To detect interactive prompts, Spawnea captures a small, bounded in-memory snapshot of the active tmux pane (via `tmux capture-pane -p -S -25`).
4. **State Adapters**: Adapters in [`packages/state/src/adapters/`](../packages/state/src/adapters/) parse the captured lines against known patterns for tools like Codex, Hermes, Antigravity, or generic shell prompts.

This design guarantees that any machine with standard `tmux` can run sessions without installing Spawnea code.

---

## Data Privacy and Retention Boundaries

Spawnea treats developer terminal output with strict privacy boundaries:

### What Spawnea Streams (Transient In-Memory Only)

- **Live Terminal Streams**: Characters received from the host are forwarded directly to the `@xterm/xterm` canvas for interactive display.
- **No Automatic Transcripts**: Spawnea does **not** record complete session transcripts, log keystrokes, or maintain a persistent history of all terminal output.
- **No Cloud Uploads**: Terminal data is never uploaded to any remote Spawnea server, telemetry service, or third party. Spawnea is 100% local-first.
- **In-Memory Tail Buffers**: The 25-line tail captured for status detection is inspected in memory and discarded on the next polling cycle; it is not written to disk.

### What Spawnea Persists Locally

Operational data needed to manage sessions is stored strictly on your local machine:

1. **Operational Catalog**: Your host and project configuration in `~/.config/spawnea/config.yaml`.
2. **Session Metadata**: Session identifiers, creation timestamps, target hosts, worktree paths, and normalized status states in a local SQLite database (`better-sqlite3`).
3. **Application Logs**: Standard diagnostic application logs, which mask sensitive credentials and secret references.
4. **Session Artifacts**: Files or images explicitly uploaded by the user or identified in the session artifact directory.
5. **Explicit Feedback Reports**: If you explicitly choose to submit a diagnostic feedback report (via the state feedback dialog), a recent tail snapshot is packaged for that specific diagnostic report.

---

## Related Source and Specifications

- [`docs/architecture.md`](architecture.md): Complete architecture specification and process boundaries.
- [`packages/hosts/src/ssh-host.ts`](../packages/hosts/src/ssh-host.ts): SSH host adapter and strict `known_hosts` verifier.
- [`packages/hosts/src/tmux-session.ts`](../packages/hosts/src/tmux-session.ts): `tmux` management and bounded tail capture.
- [`packages/state/src/adapters/`](../packages/state/src/adapters/): Status detection adapters and regex heuristics.
