import type { Session } from '@spawnea/domain';

/** Preorder traversal of the filtered UI groups, independent of disclosure state. */
export function sessionTableRows(
  roots: readonly Session[],
  children: ReadonlyMap<string, readonly Session[]>,
  visible: (session: Session) => boolean,
): Session[] {
  const rows: Session[] = [];
  const seen = new Set<string>();
  const pending = [...roots].reverse();
  while (pending.length) {
    const session = pending.pop()!;
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    if (!visible(session)) continue;
    rows.push(session);
    const descendants = children.get(session.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) pending.push(descendants[index]);
  }
  return rows;
}

function tsvCell(value: string): string {
  // Keep formula-like text literal, including formulas hidden after whitespace.
  let start = 0;
  while (start < value.length && (value.charCodeAt(start) < 32 || /\s/u.test(value[start]))) start++;
  const literal = /^[=+@-]/u.test(value.slice(start)) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return /[\t\r\n"]/u.test(literal) ? `"${literal.replaceAll('"', '""')}"` : literal;
}

export function sessionTableTsv(
  sessions: readonly Session[],
  labels: { hostName: (id: string) => string; projectName: (id: string) => string; harness: (id: string) => string },
): string {
  const header = ['Name', 'ID', 'Parent ID', 'Host', 'Project', 'Harness', 'State', 'Branch', 'Worktree', 'tmux'];
  const rows = sessions.map((session) => [
    session.name, session.id, session.parentSessionId ?? '',
    labels.hostName(session.serverId), labels.projectName(session.projectId), labels.harness(session.agentId),
    session.status, session.branch, session.worktreePath,
    `${session.tmuxSessionName}${session.tmuxWindowName ? `:${session.tmuxWindowName}` : ''}`,
  ]);
  return [header, ...rows].map((row) => row.map(tsvCell).join('\t')).join('\r\n');
}
