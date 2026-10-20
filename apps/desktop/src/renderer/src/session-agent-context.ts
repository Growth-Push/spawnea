import type { Agent, Project, Server, Session } from '@spawnea/domain';

// Bounded YAML block-field handling, not a YAML parser: space-indented mapping keys
// and compact sequence keys, literal/folded indicators, optional chomping and 1–9
// indentation modifiers. Up to two inline anchor/tag properties may precede the
// indicator; properties are recognized as text, never resolved or expanded.
// Keep neighboring text and its original line endings.
function redactCredentialBlocks(value: string): string {
  const lines = value.split(/(?<=\n)|(?<=\r)(?!\n)/);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = /^([ ]*(?:-[ \t]+)?)(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))[ \t]*:[ \t]*(?:(?:&[\w-]+|!{1,2}[\w:/.-]+|!<[^<>\s]+>)[ \t]+){0,2}[|>]((?:[1-9][+-]?|[+-][1-9]?)?)[ \t]*(?:#.*)?$/.exec(line.replace(/[\r\n]+$/, ''));
    const key = header && (header[2] ?? header[3] ?? header[4])!;
    if (!header || !/^(?:[a-z][a-z0-9]*[_-])*[a-z0-9]*(?:password|passwd|token|api[_-]?key|secret[_-]?access[_-]?key|(?:secret|private|access|signing|encryption)[_-]?key|secret|authorization|credential)$/i.test(key!)) {
      result.push(line);
      continue;
    }
    // For "- key", the key column (not the dash column) is the base indentation.
    const prefix = header[1]!;
    const modifier = /[1-9]/.exec(header[5]!);
    let contentIndent = modifier ? prefix.length + Number(modifier[0]) : undefined;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end]!;
      if (next.trim()) {
        const indent = /^ */.exec(next)![0].length;
        if (indent <= prefix.length) break;
        contentIndent ??= indent;
        if (indent < contentIndent) break;
      }
      end++;
    }
    const ending = /(?:\r\n|\r|\n)$/.exec(lines[end - 1]!)?.[0] ?? '';
    result.push(`${prefix}[REDACTED CREDENTIAL]${ending}`);
    index = end - 1;
  }
  return result.join('');
}

/** Redaction is best-effort: arbitrary unlabeled secrets cannot be recognized. */
export function redactAgentContextValue(value: string): string {
  return redactCredentialBlocks(value)
    .replace(/op:\/\/[^\r\n]*/gi, '[REDACTED 1PASSWORD REFERENCE]')
    .replace(/-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 _-]*PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
    .replace(/(?<![\w-])["']?\b(?:[a-z][a-z0-9]*[_-])*[a-z0-9]*authorization\b["']?\s*[:=]\s*(?:"(?:Basic|Bearer)\s+[A-Za-z0-9_\-.~+/=]+"|'(?:Basic|Bearer)\s+[A-Za-z0-9_\-.~+/=]+'|(?:Basic|Bearer)\s+[A-Za-z0-9_\-.~+/=]+)/gi, '[REDACTED AUTHORIZATION]')
    // Without an explicit key, require eight characters plus a digit, token separator,
    // internal period or lowercase-to-uppercase transition. Ignore sentence-final periods;
    // initial capitalization alone is ordinary prose, not evidence of a credential.
    // Also mask alphabetic runs of 24+ characters: a conservative long-token fallback
    // above common authentication prose, not a guarantee for ambiguous shorter words.
    .replace(/\bBearer\s+([A-Za-z0-9_\-.~+/=]+)/gi, (match, token: string) => {
      const candidate = token.replace(/\.+$/, '');
      const tokenShaped = /[0-9_\-~+/=]/.test(candidate) || /\./.test(candidate) || /[a-z][A-Z]/.test(candidate);
      const longAlphabetic = /^[A-Za-z]{24,}$/.test(candidate);
      return (candidate.length >= 8 && tokenShaped) || longAlphabetic
        ? `[REDACTED AUTHORIZATION]${token.slice(candidate.length)}` : match;
    })
    // Token boundaries avoid interpreting the embedded sk- in task-implementation as a key.
    .replace(/(?<![\w-])(?:sk-[\w-]{8,}|glpat-[\w-]{15,}|github_pat_[\w]+|gh[pousr]_[\w]{15,}|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16})(?![\w-])/g, '[REDACTED TOKEN]')
    // Match the complete qualified key, including environment-style and camelCase prefixes.
    // Colon values can contain spaces; stop at line/delimiter or a neighboring equals assignment.
    // Equals values remain single tokens unless quoted, preserving ordinary adjacent assignments.
    .replace(/(?<![\w-])["']?\b(?:[a-z][a-z0-9]*[_-])*[a-z0-9]*(?:password|passwd|token|api[_-]?key|secret[_-]?access[_-]?key|(?:secret|private|access|signing|encryption)[_-]?key|secret|authorization|credential)\b["']?[ \t]*(?::[ \t]*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n,;}]+?(?=[ \t]+[a-z][\w-]*[ \t]*=|[\r\n,;}]|$))|=[ \t]*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+))/gi, (match, offset: number, source: string) => {
      // Bare colon fields need a line/object boundary or a line-start YAML list indicator.
      // Inline hyphens in prose are not structured field boundaries.
      // Quoted keys and equals assignments remain recognizable anywhere.
      const bareColon = /^[\w-]+[ \t]*:/.test(match);
      const prefix = source.slice(0, offset);
      const fieldBoundary = /(?:^|[\r\n{,;])[ \t]*$/.test(prefix)
        || /(?:^|[\r\n])[ \t]*-[ \t]+$/.test(prefix);
      return !bareColon || fieldBoundary ? '[REDACTED CREDENTIAL]' : match;
    })
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi, '$1[REDACTED]@');
}

export function formatSessionAgentContext(
  session: Session,
  project?: Project,
  agent?: Agent,
  server?: Server,
): string {
  const path = (value?: string) => value && !/^catalog-(?:project|worktree):\/\//i.test(value) ? value : undefined;
  // Related records must belong to the selected session, including during selection changes.
  const selectedProject = project?.id === session.projectId ? project : undefined;
  const selectedAgent = agent?.id === session.agentId ? agent : undefined;
  const selectedServer = server?.id === session.serverId ? server : undefined;
  const fields: [string, string | undefined][] = [
    ['session id', session.id],
    ['task', session.task],
    ['project root', path(selectedProject?.rootPath)],
    ['worktree path', path(session.worktreePath)],
    ['git branch', session.branch],
    ['harness agent', selectedAgent ? `${selectedAgent.name} (${selectedAgent.harness})` : undefined],
    ['host server', selectedServer?.name],
    ['tmux target', session.tmuxSessionName ? `${session.tmuxSessionName}${session.tmuxWindowName ? `:${session.tmuxWindowName}` : ''}` : undefined],
  ];
  const body = fields.map(([label, raw]) => {
    const value = raw?.trim() ? redactAgentContextValue(raw).replace(/\r\n?/g, '\n') : 'Unavailable';
    return `${label}: ${value.replace(/\n/g, '\n  ')}`;
  }).join('\n');
  // One fence encloses all literal data, including embedded Markdown fences.
  const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length + 1)));
  return `# Spawnea context\n\n${fence}txt\n${body}\n${fence}\n`;
}
