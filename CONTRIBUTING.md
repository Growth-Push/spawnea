# Contributing to Spawnea

Thanks for contributing.

Spawnea is early-stage software. Keep changes small, explicit, and easy to review.

## Before starting

1. Read `docs/vision.md` and `docs/architecture.md`.
2. Check the relevant source contract in `docs/` when changing a documented boundary.
3. Prefer an existing task or issue before creating overlapping work.
4. For architectural changes, document the decision before broad implementation.

## Development principles

- Keep the core harness-agnostic.
- Keep remote/local behavior behind host abstractions.
- Do not scatter SSH or tmux shell commands through UI code.
- Prefer mature dependencies over custom infrastructure.
- Avoid adding features outside the current task scope.
- Preserve persistent sessions across application restarts.
- Add tests for domain behavior and failure cases when practical.
- Write all repository-authored text in English. This includes source-code identifiers and strings, UI copy, errors, logs, prompts and runtime messages, comments, tests, configuration, scripts, and documentation.
- Use non-English text only in a clearly identified fixture or test that intentionally verifies multilingual input; never use it as expected Spawnea product copy.

## Commits

Use clear imperative commit messages. Examples:

```text
Add SSH host adapter
Implement tmux session discovery
Document terminal reconnect flow
```

Keep unrelated changes in separate commits.

## Pull requests

A pull request should:

- explain the problem and approach;
- reference the task/issue when applicable;
- list important design decisions;
- describe validation performed;
- call out known limitations or follow-up work;
- update docs when behavior or architecture changes.

## Third-party code

Do not copy code from another project without checking its license.

When code is reused, preserve required notices and attribution and document the source in the pull request.

Copying ideas and architectural patterns is different from copying source code; make that distinction explicit during reference research.

## Security

Do not commit credentials, SSH private keys, tokens, production hostnames that should remain private, or sensitive user data.

See `SECURITY.md` for vulnerability reporting.
