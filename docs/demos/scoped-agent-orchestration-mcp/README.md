# Scoped agent orchestration MCP demo

This fixture models two independent local root sessions and one child per root.
It is intentionally data-only: it contains no credentials and does not touch the
application database.

Validation expectations:

- authenticate with `root-alpha`: only `root-alpha` and `child-alpha-1` are visible or actionable;
- authenticate with `root-beta`: only the beta pair is visible or actionable;
- authenticate with a child or `missing-root`: the gateway rejects the handshake;
- the stdio bridge must send `SPAWNEA_SESSION_ID` in its auth line.

The desktop test suite exercises the same boundary against an isolated in-memory
SQLite database. Run it from the repository root with:

    pnpm --filter @spawnea/desktop test -- --runInBand
