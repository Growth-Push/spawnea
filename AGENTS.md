# AGENTS.md

This repository is designed to be developed heavily with coding agents.

## Before making changes

1. Read `docs/vision.md`.
2. Read `docs/architecture.md`.
3. Read `docs/control-api-mcp.md` when working on the local control API.

## Working rules

- Work on one task at a time.
- Build every new task in its own dedicated branch/workspace rather than directly on main.
- Do not expand scope without documenting why.
- Prefer small vertical slices over broad scaffolding.
- Do not invent custom infrastructure when a mature dependency already solves the problem.
- Keep Spawnea harness-agnostic.
- Keep host, workspace, runtime, and agent concerns behind explicit interfaces.
- Keep Electron renderer code free from direct SSH/tmux process logic.
- Long-running agent sessions must survive Spawnea closing.
- Never commit credentials, SSH keys, tokens, or sensitive host configuration.
- Verify third-party licenses before copying source code.
- Use English for all repository-authored text, including source-code identifiers and strings, UI copy, errors, logs, prompts and runtime messages, comments, tests, configuration, scripts, and documentation.
- Non-English text is allowed only in an explicitly identified fixture or test case that verifies multilingual input. It must not become expected Spawnea product copy or leak into user-visible output.
- Update architecture/docs when a task changes a documented contract.
- If a problem or failure is reported more than once, the agent MUST run and verify the actual runtime execution/builds directly before presenting solutions or asking the user to test.
- When running or verifying the Electron desktop app on Linux/Wayland environments, always execute via the local project binary (`./apps/desktop/node_modules/.bin/electron`) using native Wayland flags (`--ozone-platform=wayland` or `--ozone-platform-hint=auto`) to prevent Xwayland mapping stalls.


## Completion

Before declaring a task complete:

1. Validate every acceptance criterion in its task file.
2. Run relevant tests/checks.
3. Review the diff for unrelated changes.
4. Update the backlog checkbox only when the task is actually complete.
5. Summarize validation and any remaining limitations in the commit/PR.
