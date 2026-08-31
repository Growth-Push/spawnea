# Spawnea

Spawnea is a local-first desktop IDE for operating AI coding agents across projects, worktrees, tmux sessions, and local or remote machines.

It is designed to be harness-agnostic: Codex, Claude Code, Hermes, OpenCode, shell commands, and other CLI agents should all be able to run as first-class sessions.

## Product direction

Spawnea combines:

- persistent `tmux` sessions;
- Git workspace/worktree support;
- SSH/SFTP access to remote hosts;
- an integrated terminal;
- session-aware files and Git changes;
- input/output artifacts;
- clipboard and file transfer to remote agents;
- attention states such as working, needs input, done, and error.

The active session is the current context: terminal, project, host, worktree, files, Git state, artifacts, and status all move together.

## Status

Early development. Public examples are intentionally fictional; operational catalogs, credentials, databases, logs, and other machine-specific runtime data must remain local.

## Architecture direction

Initial stack:

- Electron
- React
- TypeScript
- xterm.js
- SQLite
- SSH/SFTP
- tmux
- pnpm workspaces

See [`docs/vision.md`](docs/vision.md), [`docs/architecture.md`](docs/architecture.md), and [`docs/control-api-mcp.md`](docs/control-api-mcp.md).

## Build, test, and run

```sh
# Install the workspace dependencies from the repository root:
pnpm install --frozen-lockfile
# Build all workspace packages and the Electron desktop app:
pnpm build
# Run the automated tests:
pnpm test
# The additional development checks are:
pnpm typecheck
pnpm lint
# Run the complete validation suite, including the privacy scan, type checks, tests, build, and Electron smoke test, with:
pnpm validate
# Start the app in development mode with hot reload:
pnpm dev
```

Copy [`config/spawnea.example.yaml`](config/spawnea.example.yaml) to the per-user data directory shown by the application, then customize that local file. Spawnea does not load operational configuration from the repository working tree.

Run `pnpm privacy:check` before publishing changes. Add private names, aliases, hostnames, and customer identifiers to a local `.privacy-denylist`, one value per line, to extend the automated scan.

## Development workflow

Work is organized as epics and small executable tasks:

```text
docs/architecture.md
docs/control-api-mcp.md
```

Each task should be independently understandable by a coding agent and should include scope, acceptance criteria, dependencies, and validation steps.

## Reference implementations

Before reinventing infrastructure, we study mature open-source projects that already solve parts of the problem, including Agent Orchestrator, Emdash, Nimbalyst, Tabby, and tmux. We reuse ideas and patterns selectively, and copy code only when licensing and attribution requirements are understood and satisfied.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
