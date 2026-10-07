export interface AgentSkillPromptCatalogContext {
  profile?: string;
  projects?: Array<{
    id: string;
    name?: string;
    hostId?: string;
    rootPath?: string;
    baseBranch?: string;
  }>;
  harnesses?: Array<{
    id: string;
    name?: string;
    kind?: string;
    command?: string;
  }>;
  hosts?: Array<{
    id: string;
    name?: string;
    enabled?: boolean;
  }>;
}

function catalogText(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]+/gu, ' ').replace(/\\/gu, '\\\\').replace(/`/gu, '\\`');
}

function catalogCode(value: string | undefined): string {
  const singleLine = (value ?? '').replace(/[\r\n]+/gu, ' ');
  const longestBackticks = Math.max(0, ...(singleLine.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestBackticks + 1);
  const padding = singleLine.startsWith('`') || singleLine.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${singleLine}${padding}${fence}`;
}

/**
 * Generates the self-contained agent prompt for Spawnea orchestration.
 * This prompt can be copied by operators or output via `spawnea skill prompt`
 * to equip any AI agent (Codex, Hermes, Claude Code, AGY) with Spawnea CLI commands.
 */
export function getAgentSkillPrompt(catalog?: AgentSkillPromptCatalogContext): string {
  const profile = catalog?.profile;
  if (profile !== undefined && (profile.length > 32 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/u.test(profile))) {
    throw new Error('Invalid profile name');
  }
  const profileFlag = profile ? ` --profile ${profile}` : '';
  const profileRule = profile
    ? `\n- **Active profile context**: This Spawnea instance is operating under profile \`${profile}\`. When running outside a Spawnea-managed session terminal (where \`$SPAWNEA_PROFILE\` is automatically set), include \`--profile ${profile}\` on CLI commands or set \`export SPAWNEA_PROFILE="${profile}"\`.`
    : '';

  let catalogSection = '';
  if (catalog) {
    const projects = catalog.projects || [];
    const harnesses = catalog.harnesses || [];
    const hosts = catalog.hosts || [];
    const hasCatalogItems = projects.length > 0 || harnesses.length > 0 || hosts.length > 0 || Boolean(profile);

    if (hasCatalogItems) {
      catalogSection = `\n---\n\n## Environment Catalog\n\n`;

      if (profile) {
        catalogSection += `### Active Profile\n- \`${profile}\` (commands target this instance via \`--profile ${profile}\` or \`export SPAWNEA_PROFILE="${profile}"\`)\n\n`;
      }

      if (projects.length > 0) {
        catalogSection += `### Configured Projects\n`;
        for (const p of projects) {
          const name = p.name ? ` (${catalogText(p.name)})` : '';
          const host = p.hostId ? ` [host: ${catalogText(p.hostId)}]` : '';
          const branch = p.baseBranch ? ` [branch: ${catalogText(p.baseBranch)}]` : '';
          const path = p.rootPath ? ` - ${catalogText(p.rootPath)}` : '';
          catalogSection += `- ${catalogCode(p.id)}${name}${host}${branch}${path}\n`;
        }
        catalogSection += '\n';
      }

      if (harnesses.length > 0) {
        catalogSection += `### Available Harnesses\n`;
        for (const h of harnesses) {
          const kind = h.kind ? ` [kind: ${catalogText(h.kind)}]` : '';
          const cmd = h.command ? ` (${catalogText(h.command)})` : '';
          catalogSection += `- ${catalogCode(h.id)}: ${catalogText(h.name || h.id)}${kind}${cmd}\n`;
        }
        catalogSection += '\n';
      }

      if (hosts.length > 0) {
        catalogSection += `### Configured Hosts\n`;
        for (const h of hosts) {
          const status = h.enabled ? 'enabled' : 'disabled';
          catalogSection += `- ${catalogCode(h.id)}: ${catalogText(h.name || h.id)} (${status})\n`;
        }
        catalogSection += '\n';
      }
    }
  }

  return `# Spawnea Agent Orchestration Reference

You have access to the local \`spawnea\` CLI tool to orchestrate sessions, create child sub-agents, dispatch prompts, and inspect states.

## Key Operational Rules
- **No silent background installs**: Do not automatically create or edit configuration files or skills without explicit operator approval.
- **Fast, atomic execution**: Each \`spawnea\` command connects directly to Spawnea's local control socket, performs the requested action, and exits immediately with standard UNIX status codes (0 for success, non-zero for error).
- **Session context**: When running inside an active Spawnea session, your session identifier is available in the \`$SPAWNEA_SESSION_ID\` environment variable.${profileRule}

---

## Command Reference

### 1. List Sessions
List active sessions and their current runtime states:
\`\`\`bash
spawnea list${profileFlag}
spawnea list${profileFlag} --json
\`\`\`

### 2. Inspect Session Status
Inspect detailed state, working directory, git branch, and status for a specific session:
\`\`\`bash
spawnea status <session-id>${profileFlag}
spawnea status <session-id>${profileFlag} --json
\`\`\`

### 3. Discover Environment Catalog
Discover configured projects, harnesses, and hosts:
\`\`\`bash
spawnea catalog${profileFlag}
spawnea catalog${profileFlag} --json
\`\`\`

### 4. Create a Root Session
Create an independent root session:
\`\`\`bash
spawnea session create --project <project-id> --task "<task-description>"${profileFlag} [--agent <agent-id>] [--branch <base-branch>]
\`\`\`

### 5. Create a Child Sub-Agent
Spawn an isolated child session under an existing parent session (defaults to \`$SPAWNEA_SESSION_ID\` if omitted):
\`\`\`bash
# Create a child in the same working directory (shared workspace):
spawnea child create --parent <parent-id> --task "Review changes" --agent local:codex --workspace same-project${profileFlag}

# Create a child in an isolated managed git worktree:
spawnea child create --parent <parent-id> --task "Investigate issue" --workspace new-worktree${profileFlag}
\`\`\`

### 6. Send Prompt & Wait for Results
Dispatch a prompt to a session and read results:
\`\`\`bash
# Send prompt and wait for turn completion (prints assistant's response to stdout):
spawnea prompt send-and-wait --session <child-id> "Run the test suite and report results."${profileFlag}

# Or send asynchronously and poll turn status (only wait if delivery succeeds):
RESULT=$(spawnea prompt send --session <child-id> "Run unit tests"${profileFlag} --json)
if [ $? -eq 0 ]; then
  TURN_ID=$(echo "$RESULT" | jq -r .turnId)
  [ "$TURN_ID" != "null" ] && [ -n "$TURN_ID" ] && spawnea prompt wait --turn "$TURN_ID" --timeout 120
fi
\`\`\`

### 7. Close a Session or Child
Cleanly close a session when its task is complete:
\`\`\`bash
spawnea session close <session-id>${profileFlag}
spawnea session close <session-id>${profileFlag} --force
\`\`\`

### 8. View this Skill Prompt
Output this reference at any time:
\`\`\`bash
spawnea skill prompt${profileFlag}
spawnea skill prompt${profileFlag} --json
\`\`\`
${catalogSection}---

## Optional: Saving this Skill Locally
If you or the operator want to persist this reference as a reusable skill in this project, you may manually save the file at:
\`.agents/skills/spawnea-orchestration/SKILL.md\`
Never write this file automatically; always confirm with the operator first.
`;
}
