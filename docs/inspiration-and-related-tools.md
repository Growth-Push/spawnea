# Inspiration and Related Tools

Spawnea builds on proven developer tools and Unix patterns. This document outlines the concepts learned from related tools and explains how Spawnea's desktop architecture differs.

---

## Influential Tools and Concepts

### 1. `tmux` and Terminal Multiplexing

- **Concept**: `tmux` decouples terminal programs from the graphical desktop and network connections. Sessions live on the host system independently of window managers or SSH disconnects.
- **Influence on Spawnea**: Spawnea embraces `tmux` as its execution core. Agent sessions run inside native `tmux` sessions so that closing, restarting, or updating Spawnea never terminates running agent tasks.

### 2. Git Worktrees

- **Concept**: Native Git worktrees allow checking out multiple working trees connected to the same repository without duplicating history or re-cloning.
- **Influence on Spawnea**: Spawnea uses worktrees to give parallel agent sessions isolated workspaces and dedicated branches, avoiding conflicts and messy stash/checkout cycles.

### 3. Workmux

- **Concept**: [Workmux](https://workmux.raine.dev/) pairs Git worktrees with `tmux` sessions from the command line, providing quick terminal switching between feature branches.
- **Influence on Spawnea**: Workmux demonstrated the ergonomics of pairing one worktree with one persistent tmux session. *(Note: Spawnea is an independent desktop application and does not depend on or integrate with Workmux.)*

### 4. Agent Terminal Multiplexers (`agent-mux` and Similar Tools)

- **Concept**: CLI-based multiplexers (such as `agent-mux`) coordinate multiple AI coding agents across split terminal panes or tmux windows.
- **Influence on Spawnea**: They confirmed that running agents in real terminal shells provides maximum compatibility with existing CLI coding tools, avoiding brittle proprietary agent APIs.

---

## Why Spawnea Takes a Different Shape

While CLI scripts and terminal multiplexers work well for single repositories on a single machine, managing multiple agents across various projects and servers quickly becomes cumbersome. Spawnea was designed to address these gaps:

1. **A Unified Desktop Experience**: Rather than juggling dozens of terminal tabs and complex keybindings, Spawnea provides a searchable desktop interface with tabs, context panels, file trees, visual diffs, and artifact viewers.
2. **Multiple Projects in One Workspace**: Spawnea manages projects across different repositories and directories simultaneously.
3. **Harness-Agnostic Model**: Most agent tools assume a single AI CLI (e.g., only Claude Code or only Codex). Spawnea treats harnesses as generic launch configurations—Codex, Claude, Hermes, Antigravity, OpenCode, and standard shells all share the same session model.
4. **Local and Remote Transparency**: Sessions can run on your local laptop or remote cloud servers over standard SSH. The desktop interface provides the same file browsing, terminal interaction, and diff inspection for both.
5. **Attention as a First-Class Feature**: When running multiple agents simultaneously, the primary question is: *“Which session needs me right now?”* Spawnea continuously parses observable terminal output to surface actionable states (`working`, `needs_input`, `idle`, `error`).
6. **Zero Remote Footprint**: Unlike remote server tools that require installing daemons, containers, or agent plugins on remote machines, Spawnea requires only standard SSH access and `tmux`. The configured coding harness and its runtime dependencies remain user-managed on the target host.
7. **Strict Security and Privacy**: Spawnea maintains zero stored credentials, strictly verifies server keys against `known_hosts`, and streams terminal bytes without storing transcripts or uploading data to third-party services.
