# Spawnea Documentation

Spawnea is a local-first desktop workspace for supervising and operating AI coding agents across local machines and remote servers. It brings persistent `tmux` sessions, integrated terminals, Git worktrees, file trees, diffs, session artifacts, and agent attention state into a single desktop interface.

> [!NOTE]
> Spawnea is early-stage, pre-MVP software under active development. The guides below document the behavior currently implemented in the repository. Packaged installers and one-click binaries are pending development; running Spawnea currently requires building from source.

---

## User Guides

- **[Getting Started](getting-started.md)**  
  The fastest path from a clean repository to launching a local agent session in Spawnea, plus an overview of remote sessions.

- **[Installation and Configuration](install-and-configure.md)**  
  Prerequisites, repository setup, running the desktop app, configuring the operational catalog (`config.yaml`), and troubleshooting startup.

- **[SSH Connections](ssh.md)**  
  How Spawnea connects to remote Linux hosts over SSH, relies on remote `tmux`, enforces strict `known_hosts` verification, and maintains zero stored credentials.

- **[SSH with 1Password](ssh-with-1password.md)**  
  Using the 1Password SSH Agent with Spawnea via `IdentityAgent` or `SSH_AUTH_SOCK` for key authentication.

- **[Git Worktrees](git-worktrees.md)**  
  Isolating concurrent agent sessions with native Git worktrees, base branches, integration, stashing, and cleanup.

- **[Terminal Data and Security](terminal-data-and-security.md)**  
  Technical details on terminal streaming (`@xterm/xterm`, `node-pty`, `ssh2`), status detection from `tmux capture-pane`, and Spawnea's data privacy boundaries.

- **[Inspiration and Related Tools](inspiration-and-related-tools.md)**  
  The ideas behind Spawnea from `tmux`, Git worktrees, Workmux, and agent multiplexers, and how Spawnea provides a multi-project, multi-harness desktop model.

---

## Architecture and Specifications

- **[Vision](vision.md)**: Product goals, operational axioms, and MVP scope.
- **[Architecture Specification](architecture.md)**: Monorepo layout, process isolation, SQLite schema, and state detection.
- **[Local Control API and MCP](control-api-mcp.md)**: Local Unix-domain socket MCP server and protocol contract.
- **[Public-Source Privacy](public-source-privacy.md)**: Privacy standards and sanitization rules.

---

## Feedback, Issues, and Security

We welcome feedback, bug reports, and targeted feature requests.

- **Bug Reports**: If you encounter unexpected behavior, check the troubleshooting sections in the guides or submit an issue using the [Bug Report template](../.github/ISSUE_TEMPLATE/bug_report.yml).  
  *Important*: Always sanitize terminal output, logs, and screenshots before posting. Remove private keys, passwords, API tokens, internal IP addresses, and sensitive file paths.
- **Feature Proposals**: Propose focused workflows or enhancements using the [Feature Request template](../.github/ISSUE_TEMPLATE/feature_request.yml).
- **Security Vulnerabilities**: Do not disclose security vulnerabilities on public issue trackers. Follow the reporting instructions in [SECURITY.md](../SECURITY.md).
