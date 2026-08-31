# TASK 02 — Harden the repository for first public publication

**Status:** draft

## Goal

Produce a first public commit candidate that contains no private runtime data, passes every declared publication gate, and does not ship known high-impact Electron or SSH trust-boundary flaws.

## Success criteria

- The complete Git candidate tree passes the privacy scan and a real Gitleaks scan without suppressing genuine findings.
- GitHub Actions uses immutable action revisions and every named gate performs real work.
- The lint command checks repository source instead of succeeding as a no-op.
- Electron grants the preload API only to the trusted application renderer, blocks untrusted navigation and child windows, and enables renderer sandboxing when compatible with the bundled preload.
- SSH connections authenticate the remote host according to the policy selected below and reject mismatches deterministically.
- Public docs accurately describe security behavior, validation commands, pre-MVP limitations, and task status.
- Frozen install, privacy, typecheck, lint, tests, build, smoke, dependency audit, secret scan, and license policy checks pass.
- No local environment file, log, database, generated output, package store, or runtime descriptor is a Git candidate.

## Research summary

- [Repository instructions](../../AGENTS.md): public work must preserve credentials, respect Electron/Wayland runtime guidance, run real checks, and update documented contracts.
- [Security policy](../../SECURITY.md): SSH handling, command construction, IPC, credentials, and logs are explicitly security-sensitive.
- [Electron main process](../../apps/desktop/src/main/index.ts): the renderer currently runs with `sandbox: false`; child windows are allowed for localhost and non-HTTP schemes; top-level navigation is not guarded.
- [Electron preload](../../apps/desktop/src/preload/index.ts): every loaded document receives a broad API with filesystem, PTY, host, artifact, session, and destructive finalization capabilities.
- [SSH host adapter](../../packages/hosts/src/ssh-host.ts): `ssh2` receives no `hostVerifier`, so remote host identity is not authenticated; the adapter also reads private-key files directly despite the architecture's delegated-auth wording.
- [CI workflow](../../.github/workflows/ci.yml): publication gates exist, but third-party actions use mutable major-version tags.
- [Root manifest](../../package.json): `pnpm lint` uses `--if-present`; no workspace package defines a lint script, so the gate currently checks nothing.
- Gitleaks 8.30.1 found two test-fixture patterns in the candidate tree, which means the declared CI secret gate would reject the first public candidate.
- `pnpm audit --audit-level=high` passes with no high or critical findings; two moderate findings remain in development tooling.
- The repository has no commits. All 233 candidate paths are untracked, so there is no historical diff to review or preserve.

## Subtasks

1. **Make publication gates truthful** — adjust synthetic secret fixtures without weakening behavior tests, add a reproducible local secret-scan command, replace the no-op lint gate with an actual linter, and pin CI actions to immutable revisions.
2. **Constrain Electron privileges** — extract and test renderer URL/navigation policy, deny child windows, open approved HTTP(S) links externally, reject untrusted top-level navigation, validate IPC senders at the main-process boundary, and enable sandboxing if the built preload supports it.
3. **Authenticate SSH hosts** — implement the selected known-host policy behind the host adapter, cover known, unknown, changed, hashed, and malformed host entries as applicable, and avoid logging key material.
4. **Align credential behavior and docs** — either delegate private-key use consistently through the configured agent or explicitly document and test the narrower in-memory key-file behavior; do not persist key contents.
5. **Close publication metadata drift** — synchronize task status and document the real checks, known moderate dependency findings, and supported security model.
6. **Prepare the Git candidate** — inspect the final candidate list and ignored-sensitive paths, rerun all gates, review the staged diff, and propose a coherent commit sequence without pushing or publishing.

## Validation

- `pnpm install --frozen-lockfile` — deterministic workspace installation.
- `pnpm privacy:check` — repository-specific privacy and portability policy.
- `pnpm lint && pnpm typecheck && pnpm test` — static and deterministic behavior checks.
- `pnpm build && pnpm smoke` — Electron compilation and real headless startup.
- `pnpm audit --audit-level=high` — high/critical dependency gate.
- `pnpm secret:scan` — candidate-tree secret scan with synthetic-fixture handling explicit in version control.
- `pnpm license:check` — fail-closed production dependency license policy.
- Focused Electron navigation/IPC and SSH host-verification tests — security boundary behavior and failure paths.
- `git status --short --ignored` plus final candidate inventory — local/runtime files remain excluded.

## Human acceptance

1. Review the selected SSH host-key policy and its first-connection behavior.
2. Start the desktop app and confirm normal local renderer, terminal, files, artifacts, and external links still work.
3. Confirm an untrusted renderer URL/window cannot access `window.spawneaApi` or invoke IPC.
4. Connect to a known SSH host successfully and confirm an unknown or changed key follows the selected failure behavior.
5. Review the final staged paths and proposed commits before any commit, push, or public repository action.

## Open decisions

- Select strict `~/.ssh/known_hosts` verification, local TOFU fingerprint persistence, or explicit deferral. Strict known-host verification is recommended because it matches established OpenSSH trust and avoids creating a new credential-like store.

## Out of scope

- No push, GitHub repository creation, release, package publication, deployment, production operation, billing, or account changes.
- No unrelated UI or architecture refactor.
- No destructive change to local databases, SSH configuration, credentials, or runtime state.
