<p align="center">
  <img src="docs/assets/spawnea-logo.png" alt="Spawnea" width="152">
</p>

<p align="center">
  A local-first desktop workspace for running and coordinating AI coding agents.
</p>

<p align="center">
  <a href="https://github.com/Growth-Push/spawnea/actions/workflows/ci.yml"><img src="https://github.com/Growth-Push/spawnea/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933.svg" alt="Node.js 24 or newer">
  <img src="https://img.shields.io/badge/pnpm-10-F69220.svg" alt="pnpm 10">
</p>

Spawnea brings terminals, persistent `tmux` sessions, Git worktrees, files, artifacts, and agent attention state into one desktop workspace. It is harness-agnostic: Codex, Hermes, Claude Code, Antigravity, OpenCode, shell commands, and other CLI agents can run as first-class sessions.

## Why Spawnea

AI coding sessions become difficult to operate when they are spread across terminal tabs, worktrees, servers, and disconnected status signals. Spawnea keeps the active context together: host, project, worktree, agent, terminal, files, Git state, artifacts, and attention state.

Its philosophy is deliberately simple:

- **Local-first:** the desktop application is the control plane; there is no hosted Spawnea backend.
- **tmux-native:** long-running sessions survive Spawnea closing, updating, or crashing.
- **Harness-agnostic:** an agent is a configured command, not a closed vendor integration.
- **Remote-light:** remote hosts need existing SSH access and `tmux`; Spawnea installs nothing there.
- **Observable:** session state comes from process, tmux, and terminal output rather than hidden hooks.

## What it does

- Run Codex, Hermes, Claude Code, Antigravity, OpenCode, and shell sessions.
- Manage local and remote hosts through SSH/SFTP.
- Create and operate Git worktrees and branch-aware workspaces.
- Keep a persistent terminal attached to each session.
- Browse project files and inspect Git changes in context.
- Transfer files and clipboard content to remote agent sessions.
- Collect explicit input/output artifacts.
- Surface normalized states such as working, needs input, idle, done, and error.
- Coordinate multiple sessions from one searchable desktop interface.
- Expose an explicit local MCP control surface for approved automation.

## Remote hosts and terminal data

Spawnea does not install a daemon, package, plugin, hook, service, or background process on VPSs or other remote hosts. For a host that is already reachable over SSH, Spawnea-managed sessions only expect `tmux` to be available. The agent command and its dependencies remain user-managed.

Hermes and other harness states are inferred by reading terminal/tmux output and parsing rendered prompts and responses. No harness hook, event file, or resident helper process is required by the base runtime.

The terminal view uses the open-source [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) library, with `node-pty` and `ssh2` for PTY and SSH transport. Terminal bytes are streamed to the local UI; Spawnea does not record a conversation transcript or upload terminal data to a Spawnea service. Local configuration, session metadata, logs, artifacts, and explicitly requested diagnostic reports remain separate persistence features.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm dev
```

For a production-style local build:

```sh
pnpm build
pnpm start
```

To package the desktop application for the current host without publishing:

```sh
pnpm package:desktop:host
```

See [Desktop distribution](docs/desktop-distribution.md) for supported release artifacts and the GitHub Release process.

Operational configuration is user-owned runtime data and is documented separately. It is not loaded from the repository working tree.

## Project status

Spawnea is early-stage and under active development. Interfaces and runtime behavior may evolve before the first stable release.

## Documentation

- [User Documentation Index](docs/index.md)
- [Getting Started](docs/getting-started.md)
- [Installation and Configuration](docs/install-and-configure.md)
- [Vision](docs/vision.md)
- [Architecture](docs/architecture.md)
- [Local control API and MCP](docs/control-api-mcp.md)
- [Public-source privacy boundary](docs/public-source-privacy.md)

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm validate
```

Run `pnpm privacy:check` before publishing changes. Never commit credentials, SSH keys, tokens, private host configuration, or machine-specific runtime data.

## License

Spawnea is released under the [Apache License 2.0](LICENSE).

<p align="center">
  <img src="docs/assets/spawnea-wizard.gif" alt="Spawnea wizard casting agent sessions" width="480">
</p>
