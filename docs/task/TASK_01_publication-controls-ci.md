# TASK 01 — Add publication controls to CI

**Status:** complete

## Goal
Run the repository's publication checks automatically on GitHub pull requests and pushes, failing the job for high-severity dependency vulnerabilities, detected secrets, or license-policy violations.

## Success criteria
- A GitHub Actions workflow installs with `pnpm install --frozen-lockfile` using the repository's pinned pnpm and Node versions.
- The workflow runs privacy check, typecheck, lint, tests, build, high-severity audit, secret scanning, and license verification.
- Secret scanning fails on findings and does not print credential contents.
- Dependency audit fails at the configured high-severity threshold.
- License verification fails when dependencies violate the repository's declared policy.
- Existing local `pnpm validate` behavior remains unchanged.

## Research summary
- [Repository instructions](../../AGENTS.md): publication checks must cover privacy, typecheck, lint, tests, build, smoke, dependency audit, secrets, and licenses; authored text must be English.
- [Architecture specification](../architecture.md): CI strategy names `pnpm audit --audit-level=high`, gitleaks/regex secret scanning, and license verification as required controls.
- [Root manifest](../../package.json): pins pnpm 10.15.0, requires Node 24+, and exposes privacy, typecheck, lint, test, build, smoke, validate, and ci scripts.
- [Lockfile](../../pnpm-lock.yaml): frozen installation is available for deterministic CI setup.
- `.github/` currently contains issue/PR templates but no workflow; this task adds one bounded workflow and no production integrations.
- `docs/task/` is not ignored by the current repository rules, so this plan is versionable.

## Subtasks
1. Add a single GitHub Actions workflow for push and pull-request validation.
2. Configure pinned Node/pnpm setup and frozen dependency installation with caching.
3. Run repository-native checks plus audit, secret scanning, and license verification with explicit failure behavior.
4. Add or document only the smallest license policy needed by the chosen verifier; avoid silently allowing unknown licenses.
5. Verify workflow syntax and execute every locally runnable command, including failure-threshold checks where practical.

## Validation
- `pnpm install --frozen-lockfile` — proves CI installation is reproducible.
- `pnpm privacy:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — proves repository checks remain green.
- `pnpm audit --audit-level=high` — proves the high-severity dependency gate.
- Secret scanner and license verifier commands — prove both publication gates execute and fail on violations.
- Workflow YAML parsing or actionlint, when available — proves the workflow is syntactically valid.

## Human acceptance
1. Inspect the workflow under `.github/workflows/` and confirm it triggers on pull requests and the default branch.
2. Open a pull request or push to the default branch and confirm all listed checks execute.
3. Confirm a temporary test secret, high-severity audit result, or disallowed license makes the corresponding job fail; remove any temporary fixture afterward.

## Out of scope
- No deployment, release, publishing, credential, account, or production changes.
- No changes to application runtime behavior or local database state.
- No broad CI matrix or platform-specific packaging workflow beyond the requested publication gate.
