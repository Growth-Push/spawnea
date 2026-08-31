# Public-source privacy and portability

Spawnea's source tree must be safe to publish and portable across developer machines.

## Repository contract

- Public examples and tests use fictional, generic identities and paths.
- Operational catalogs are user-owned runtime data and are never loaded from the repository by default.
- The default catalog lives in the application's per-user data directory.
- Absolute workspace paths may exist at runtime because Spawnea operates local and remote filesystems, but repository-authored defaults must not depend on one developer's filesystem.
- Logs and errors must not expose credentials or secret references. Paths shown inside the trusted local desktop UI are operational data, not public source configuration.
- A privacy scan must pass before publishing or committing source files.

## Bootstrap exception

This task is being completed before Git is initialized, at the repository owner's request. Therefore it cannot use the normal task branch/workspace workflow. Future tasks must follow `AGENTS.md` after the clean initial commit exists.

## Acceptance criteria

- No repository-authored fixture or example identifies a real developer, host, customer, or filesystem layout.
- No operational catalog is selected from the repository working directory.
- Local operational catalogs, databases, logs, and environment overrides are ignored.
- The privacy scan rejects common personal absolute paths and known sensitive runtime files.
- Type checks, tests, build, and smoke validation pass.
