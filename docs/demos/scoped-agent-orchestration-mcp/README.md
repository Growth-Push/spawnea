# Scoped agent orchestration MCP demo

This fixture models two independent local root sessions and one child per root.
It is intentionally data-only: it contains no credentials and does not touch the
application database.

Validation expectations:

- authenticate with `root-alpha`: only `root-alpha` and `child-alpha-1` are visible or actionable;
- authenticate with `root-beta`: only the beta pair is visible or actionable;
- authenticate with a child or `missing-root`: the gateway rejects the handshake;
- for the existing-root flow, the stdio bridge must send `SPAWNEA_SESSION_ID` in its auth line.

The target parent-session bootstrap adds a separate absent-ID flow. Once
implemented, bootstrap discovery must not reveal either root in this fixture;
after `spawnea_create_session`, the connection must expose only the newly created
root and its direct children. It must still accept an exact creation replay, and
a replacement absent-ID connection must use that replay to bind to the same root
without creating another session or worktree. Only those bootstrap-bound
connections may deliver prompts to the root. A connection using the root's
injected `SPAWNEA_SESSION_ID` must remain limited to direct-child prompt
delivery. The current bridge still rejects the absent-ID flow before MCP
initialization.

The desktop test suite exercises the same boundary against an isolated in-memory
SQLite database. Run it from the repository root with:

    pnpm --filter @spawnea/desktop test -- --runInBand
