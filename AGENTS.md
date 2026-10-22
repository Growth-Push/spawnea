# AGENTS.md

This repository is designed to be developed heavily with coding agents.

## Before making changes

1. Read `docs/vision.md`.
2. Read `docs/architecture.md`.
3. Read `docs/control-api.md` when working on the local control API.

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
- When changing terminal selection or reference detection, distinguish terminal-cell coordinates from UTF-16 offsets and soft wraps from hard line breaks. Validate affected behavior with real xterm buffers, covering relevant Unicode and forward/reverse selection cases; string-only mocks are insufficient for these contracts.
- If a problem or failure is reported more than once, the agent MUST run and verify the actual runtime execution/builds directly before presenting solutions or asking the user to test.
- When running or verifying the Electron desktop app on Linux/Wayland environments, always execute via the local project binary (`./apps/desktop/node_modules/.bin/electron`) using native Wayland flags (`--ozone-platform=wayland` or `--ozone-platform-hint=auto`) to prevent Xwayland mapping stalls.


## Public pull requests and repository communication

- Treat PR titles, descriptions, comments, commit messages, and attached evidence as public.
- Make each PR self-contained: explain **what changed**, **why it was needed**, and **how it was validated**, including relevant compatibility risks and remaining limitations. Readers must not need access to a private tracker or conversation to understand the change.
- Do not include private ticket references, private repository names or links, internal coordination/session identifiers, customer details, personal machine paths, credentials, or sensitive host data. Describe the technical problem and rationale in generic, public-safe terms instead.
- Link an issue only when it is public and relevant. If the PR template asks for a related task or issue and no suitable public issue exists, omit that section or state that none is linked; never substitute a private reference.
- Report validation accurately: identify the checks actually run and their results, and explicitly distinguish failed, blocked, skipped, or unrun checks. Do not present fixtures or smoke tests as proof of untested real-provider, remote-host, or interactive behavior.
- Before publishing or updating a PR, review its text, diff, screenshots, and logs for private information as well as secrets. Use fictional examples and sanitized evidence; preserve useful public technical detail.
- Keep private planning and coordination in their authorized private channels. Public repository artifacts must stand on their own.

## Required local reviews

- In this Spawnea repository, run both local Codex and local CodeRabbit reviews before every commit or PR. Both must review the current diff, including untracked and new files.
- Before requesting fixes, the coordinator classifies each finding by reproducibility, meaningful user impact and approved scope; a bot severity label alone does not decide the outcome:
  - **Fix now:** reproducible, within scope, and materially affects privacy, security, functionality or agreed acceptance criteria.
  - **Defer:** valid but marginal, low-impact, or an expansion of scope; record why without calling it a false positive.
  - **Dismiss:** an incorrect premise, false positive, or deliberate behavior under the approved contract; record evidence or a reason.
- Fix findings classified as Fix now. A consequential defect does not become low-impact because its fix is costly. After code changes, obtain fresh reviews from both tools on the updated diff before proceeding.
- Within approved task scope, resolve findings classified as Fix now and rerun both reviews without requesting additional authorization or stopping solely at a review-round limit; material scope changes and other unapproved actions still require direction.
- Record the reviewed revision and diff (including untracked/new file contents), the exact review commands, results, and the disposition of actionable findings. Unavailable, failed, or rate-limited reviews are not passing reviews; report them as blocked and do not proceed to commit or PR until both required reviews are complete.
- A task can finish when agreed acceptance criteria and required checks pass, both required reviews are complete, and no Fix now findings remain. Deferred and dismissed findings require a recorded reason, not another fix/review round or elimination of every bot suggestion.

## Completion

Before declaring a task complete:

1. Validate every acceptance criterion in its task file.
2. Run relevant tests/checks.
3. Review the diff for unrelated changes.
4. Update the backlog checkbox only when the task is actually complete.
5. Summarize validation and any remaining limitations in the commit/PR.
