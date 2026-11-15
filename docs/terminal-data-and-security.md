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

PTY output arriving before the renderer signals readiness is held in a bounded per-channel buffer. The broker pauses the PTY stream at its high-water mark, flushes the buffered data in order when the renderer is ready, and resumes after xterm acknowledges enough rendered bytes. Disposing the terminal view or destroying its renderer closes the PTY attachment and releases its buffer; the tmux session continues running.

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
3. **Bounded Tail Inspection**: To detect interactive prompts, Spawnea captures a small, bounded in-memory snapshot of the active tmux pane (via `tmux capture-pane -p -S -50`).
4. **State Rules**: Harness adapters in [`packages/state/src/adapters/`](../packages/state/src/adapters/) trim the captured lines by context, and ordered YAML [state rules](state-rules.md) evaluate the last 10 lines of the result. An optional local user rules file (`<userData>/state-rules.yaml`) is read once at startup; Spawnea never uploads it. Status results carry the matched line, the deciding rule's file, harness, and position, and only a digest of the evaluated window, never its text.

This design guarantees that any machine with standard `tmux` can run sessions without installing Spawnea code.

---

## Data Privacy and Retention Boundaries

Spawnea treats developer terminal output with strict privacy boundaries:

### What Spawnea Streams (Transient In-Memory Only)

- **Live Terminal Streams**: Characters received from the host are forwarded directly to the `@xterm/xterm` canvas for interactive display without continuous recording.
- **No Continuous PTY or Full-Transcript Recording**: Spawnea does **not** continuously record raw PTY streams, log keystrokes, or archive complete provider transcripts on its own.
- **No Cloud Uploads**: Terminal data is never uploaded to any remote Spawnea server, telemetry service, or third party. Spawnea is 100% local-first.
- **Volatile Caches and Comparison State**: Status-detection comparison windows, volatile prompt-replay/retry deduplication caches, and scoped **Agent Context** call records remain strictly in-memory only and are discarded on restart.

### What Spawnea Persists Locally

Operational data and bounded restart-recovery state are stored strictly on your local machine:

1. **Operational Catalog**: Your host and project configuration in `~/.config/spawnea/config.yaml`.
2. **Session Metadata and Bounded Restart-Recovery History (`better-sqlite3`)**:
   - **Session metadata:** Session identifiers, creation timestamps, target hosts, worktree paths, and normalized status states.
   - **Automatic latest screen snapshots:** Even when the Mobile HTTP adapter is disabled, each successful Desktop status-check capture replaces a single bounded latest screen snapshot per session (`64 KiB` output and up to `50` parsed screen items, `7`-day TTL measured from `capturedAt`). Identical re-observations do not bump `version` or `updatedAt`, and failed or empty captures never overwrite prior snapshots or refresh `capturedAt`.
   - **Bounded control turns and request metadata:** Control/CLI prompt runs persist up to `256 KiB` of output per turn, `200` turns per session, `1,000` turns globally, and up to `50` request-delivery metadata records per session (`7`-day TTL, shared `32 MiB` aggregate serialized payload budget).
   - **Lifecycle cleanup and cleartext access:** Expired rows age out after `7` days and oldest records prune under count and `32 MiB` payload limits at startup, on retained writes and lookups, and on an hourly cleanup schedule in Desktop session supervision (running independently of active sessions or terminal capture success), while snapshots/turns cascade-delete when the owning session is deleted. Unlike full continuous PTY recording or provider transcripts, only these bounded latest snapshots and control turns are retained. Persisted text is stored locally in **cleartext without automatic redaction**, can contain sensitive terminal output rendered on screen, and is readable by the local OS user account and authorized Desktop/control/Mobile callers.
   - **POSIX storage permissions and platform limits:** On supported POSIX systems (Linux and macOS), Spawnea enforces owner-only permissions (`0600`) on writable file-backed SQLite database files (`spawnea.sqlite`) and their `-wal`, `-shm`, and `-journal` sidecars before migrations and retained-content writes (creating missing database subdirectories as `0700` without altering unrelated existing parent directories or read-only opens), and **fails closed** if protection cannot be established (such as symlink targets or unsecurable permissions). On Windows, POSIX mode bits do not provide equivalent enforcement and Spawnea relies on the user's Windows profile ACLs rather than enforcing custom ACLs.
3. **Application Logs**: Bounded, rotating diagnostic logs stored under the private application user-data directory. Explicit `SPAWNEA_LOG_FILE` overrides are respected and should point to a private location. Logs contain structured operational metadata, not command strings or terminal transcripts.
4. **Session Artifacts**: Files or images explicitly uploaded by the user or identified in the session artifact directory.
5. **Explicit Feedback Reports**: If you explicitly choose to submit a diagnostic feedback report (via the state feedback dialog), a recent tail snapshot is packaged for that specific report. The report can contain sensitive terminal text and user notes. It also records the displayed and expected status, which state rule (file, harness, and position) or fallback decided the detected status, and which rules configuration was in use; it never includes rule patterns, the user rules file path, or validation error text. If the snapshot capture fails, the report is saved without a detected status, source, confidence, or terminal tail rather than with guessed values. See [State Rules](state-rules.md#report-wrong-state). The file and directory use private permissions (`0600` and `0700`). It remains locally in the application user-data `feedback` directory until manually removed; Spawnea does not upload it. `SPAWNEA_FEEDBACK_DIR` replaces that default directory and must point to a private local directory.

Fatal process handlers also apply the structured redaction rules before writing to the console. Arbitrary exception text cannot be guaranteed to be free of every possible secret, so users should treat diagnostic output as private.

Artifact cache retention is bounded by the desktop artifact manager: 50 MiB per
cached file, 250 MiB total cache usage, and 10 MiB per preview by default. These
limits are enforced for automatic output discovery and on-demand reads. An
oversized automatic output may remain registered as metadata without a local
copy; explicit promotion reports the size limit. Truncated previews are not
cached and cannot be exported as complete files. Cache names include a hash of
the complete source locator and direction so same-basename artifacts remain
independent.

---

## Related Source and Specifications

- [`docs/architecture.md`](architecture.md): Complete architecture specification and process boundaries.
- [`packages/hosts/src/ssh-host.ts`](../packages/hosts/src/ssh-host.ts): SSH host adapter and strict `known_hosts` verifier.
- [`packages/hosts/src/tmux-session.ts`](../packages/hosts/src/tmux-session.ts): `tmux` management and bounded tail capture.
- [`packages/state/src/adapters/`](../packages/state/src/adapters/): Status detection adapters (context preparation steps and the decision order).
- [`packages/state/src/rules/state-rules.yaml`](../packages/state/src/rules/state-rules.yaml): Factory state rules.
