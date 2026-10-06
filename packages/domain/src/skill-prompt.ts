/**
 * Generates the self-contained agent prompt for Spawnea orchestration.
 * This prompt can be copied by operators or output via `spawnea skill prompt`
 * to equip any AI agent (Codex, Hermes, Claude Code, AGY) with Spawnea CLI commands.
 */
export function getAgentSkillPrompt(): string {
  return `# Spawnea Agent Orchestration Reference

You have access to the local \`spawnea\` CLI tool to orchestrate sessions, create child sub-agents, dispatch prompts, and inspect states.

## Key Operational Rules
- **No silent background installs**: Do not automatically create or edit configuration files or skills without explicit operator approval.
- **Fast, atomic execution**: Each \`spawnea\` command connects directly to Spawnea's local control socket, performs the requested action, and exits immediately with standard UNIX status codes (0 for success, non-zero for error).
- **Session context**: When running inside an active Spawnea session, your session identifier is available in the \`$SPAWNEA_SESSION_ID\` environment variable.

---

## Command Reference

### 1. List Sessions
List active sessions and their current runtime states:
\`\`\`bash
spawnea list
spawnea list --json
\`\`\`

### 2. Inspect Session Status
Inspect detailed state, working directory, git branch, and status for a specific session:
\`\`\`bash
spawnea status <session-id>
spawnea status <session-id> --json
\`\`\`

### 3. Create a Root Session
Create an independent root session:
\`\`\`bash
spawnea session create --project <project-id> --task "<task-description>" [--agent <agent-id>] [--branch <base-branch>]
\`\`\`

### 4. Create a Child Sub-Agent
Spawn an isolated child session under an existing parent session (defaults to \`$SPAWNEA_SESSION_ID\` if omitted):
\`\`\`bash
# Create a child in the same working directory (shared workspace):
spawnea child create --parent <parent-id> --task "Review changes" --agent local:codex --workspace same-project

# Create a child in an isolated managed git worktree:
spawnea child create --parent <parent-id> --task "Investigate issue" --workspace new-worktree
\`\`\`

### 5. Send Prompt & Wait for Results
Dispatch a prompt to a session and read results:
\`\`\`bash
# Send prompt and wait for turn completion (prints assistant's response to stdout):
spawnea prompt send-and-wait --session <child-id> "Run the test suite and report results."

# Or send asynchronously and poll turn status:
TURN_ID=$(spawnea prompt send --session <child-id> "Run unit tests" --json | jq -r .turnId)
[ "$TURN_ID" != "null" ] && [ -n "$TURN_ID" ] && spawnea prompt wait --turn "$TURN_ID" --timeout 120
\`\`\`

### 6. Close a Session or Child
Cleanly close a session when its task is complete:
\`\`\`bash
spawnea session close <session-id>
spawnea session close <session-id> --force
\`\`\`

### 7. View this Skill Prompt
Output this reference at any time:
\`\`\`bash
spawnea skill prompt
spawnea skill prompt --json
\`\`\`

---

## Optional: Saving this Skill Locally
If you or the operator want to persist this reference as a reusable skill in this project, you may manually save the file at:
\`.agents/skills/spawnea-orchestration/SKILL.md\`
Never write this file automatically; always confirm with the operator first.
`;
}
