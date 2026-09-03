# Installation and Configuration

Spawnea is currently installed and run directly from source. Packaged binary installers (such as AppImage, `.deb`, `.dmg`, or `.exe`) and pre-built GitHub Releases are in development and are not yet published.

---

## Prerequisites

Before setting up Spawnea, verify your system has the following tools:

1. **Node.js**: Version 24.0.0 or newer. Check with `node -v`.
2. **pnpm**: Version 10 (specified in `package.json` as `pnpm@10.15.0`). Check with `pnpm -v`.
3. **C/C++ Build Toolchain**: Required to compile native modules (`better-sqlite3` and `node-pty`).
   - On Debian/Ubuntu: `sudo apt install build-essential python3`
   - On Fedora/RHEL: `sudo dnf groupinstall "Development Tools"`
   - On macOS: `xcode-select --install`
4. **tmux**: Installed locally and in `$PATH` (`tmux -V`). Any remote host you connect to must also have `tmux` installed.
5. **Git**: Installed and available in `$PATH`.

---

## Installing and Running from Source

Clone the repository and install dependencies using the frozen lockfile:

```bash
git clone https://github.com/Growth-Push/spawnea.git
cd spawnea
pnpm install --frozen-lockfile
```

### Running in Development Mode

To start the desktop application with hot module replacement for development:

```bash
pnpm dev
```

### Running a Production Build

To compile all monorepo packages and launch the desktop application:

```bash
pnpm build
pnpm start
```

On Linux environments running Wayland, `pnpm start` automatically passes `--ozone-platform-hint=auto` to avoid Xwayland mapping delays.

---

## Configuration: The Operational Catalog

Spawnea uses a YAML configuration file called the **Operational Catalog** to define hosts, projects, and coding harnesses.

### Location of `config.yaml`

Spawnea resolves your configuration file in the following order:

1. Path specified in the `SPAWNEA_CONFIG` or `SPAWNEA_CATALOG_PATH` environment variable.
2. `$SPAWNEA_HOME/config.yaml` or `$SPAWNEA_HOME/spawnea.yaml` (if set).
3. `~/.config/spawnea/config.yaml` (default location).

The repository working tree is never used as an active catalog.

### Example Configuration

Below is a minimal `config.yaml` defining a local workstation and an SSH remote host:

```yaml
version: 1

hosts:
  local:
    name: Local Workstation
    enabled: true

    projects:
      my-project:
        name: My Project
        path: ~/code/my-project
        base_branch: main
        worktree:
          enabled: true
          copy_files:
            - .env.example
        enabled: true

    harnesses:
      claude:
        name: Claude Code
        command: claude
        args: []
        enabled: true

      shell:
        name: Interactive Shell
        command: bash
        args: []
        enabled: true

  remote-dev:
    name: Remote Dev Server
    enabled: true
    ssh:
      target: dev-box       # Hostname or alias from ~/.ssh/config
      user: developer       # SSH user (optional if configured in ~/.ssh/config)
      port: 22

    projects:
      backend:
        name: Backend Service
        path: ~/code/backend
        base_branch: main
        # Optional. Empty by default: Spawnea does not change tmux options.
        tmux:
          options: {}
          # To opt in, replace the empty map with for example:
          # options:
          #   mouse: on
          #   history-limit: 50000
          commands: []
        enabled: true

    harnesses:
      codex:
        name: Codex CLI
        command: codex
        args: []
        enabled: true

      shell:
        name: Remote Shell
        command: bash
        args: []
        enabled: true
```

A reference template is available in the repository at [`config/spawnea.example.yaml`](../config/spawnea.example.yaml).

### Optional tmux settings

Project-level `tmux.options` applies explicit `tmux set-option` values when a new session is created. The session target is added automatically. `tmux.commands` runs explicit tmux subcommands after creation. Each command is an array of arguments, which Spawnea shell-quotes before execution. Use the `{{session}}` argument when the command needs the generated session target. Both are empty by default and are not run again when Spawnea attaches to an existing session.

For example, this enables mouse reporting and increases the scrollback buffer for sessions belonging to one project:

```yaml
tmux:
  options:
    mouse: on
    history-limit: 50000
  commands: []
```

Other useful session options include:

```yaml
tmux:
  options:
    # Hide the tmux status line.
    status: off
    # Refresh the status line every second when it is enabled.
    status-interval: 1
    # Keep tmux messages visible for five seconds.
    display-time: 5000
  commands: []
```

Use `commands` for tmux operations that are not session options, such as window settings or hooks. Each entry is appended after `tmux` and runs once after the new session is created. Use `{{session}}` as a placeholder when a command needs the generated session name:

```yaml
tmux:
  options: {}
  commands:
    - [set-window-option, -t, "{{session}}", mode-keys, vi]
    - [set-window-option, -t, "{{session}}", remain-on-exit, on]
```

Spawnea replaces the `{{session}}` argument with the generated session name. Avoid putting credentials or unrelated host changes in this list.

### Adding Projects via the UI

You do not have to write YAML by hand for new projects:

1. Click **Add Project** in Spawnea.
2. Select the host.
3. Enter the project ID, display name, and folder path.
4. Click **Add Project**.

Spawnea safely inserts the project into your active `config.yaml` while preserving existing comments and formatting.

### Local Discovery

Spawnea includes an explicit, read-only discovery tool:

1. Open **Discover local setup** from the sidebar.
2. Spawnea inspects `/etc/hosts` for host aliases and checks your local `$PATH` for allowlisted agent CLIs (`claude`, `codex`, `hermes`, `opencode`, and standard shells).
3. The scan makes no network connections and runs no commands.
4. You review a preview of proposed changes and confirm before Spawnea writes to `config.yaml`.

---

## Troubleshooting

### Native Module Build Failures (`node-pty` / `better-sqlite3`)

If you see errors such as `Cannot find module .../pty.node` or `better-sqlite3.node`:

- Ensure Python 3 and a C++ compiler (`g++` / `clang++`) are installed.
- Run `pnpm dev` or `pnpm build`, which invokes `electron-rebuild` for the Electron ABI.
- For pure Node testing without Electron, running `pnpm test` triggers the Node ABI rebuild.

### Missing `tmux`

If session creation fails with an error stating `tmux is not installed`:

- On the local machine, install `tmux` with your package manager (`apt install tmux`, `brew install tmux`, etc.).
- On remote SSH hosts, SSH into the machine and install `tmux`. Spawnea does not install packages remotely.

### Missing Harness Command

If an agent session starts in tmux but exits immediately or displays `command not found`:

- Verify the harness executable is installed and in the `$PATH` of the login shell on that host.
- For remote hosts, ensure non-interactive or login shells inherit the necessary paths (e.g., `~/.local/bin` or npm global binaries).

### Linux Display or Wayland Issues

If Spawnea fails to open a window on Linux under Wayland:

- Launch with `--ozone-platform-hint=auto` or `--ozone-platform=wayland`:
  ```bash
  ./apps/desktop/node_modules/.bin/electron --ozone-platform-hint=auto apps/desktop/out/main/index.js
  ```
- If hardware acceleration issues occur on virtual machines or containers, you can append `--disable-gpu`.
