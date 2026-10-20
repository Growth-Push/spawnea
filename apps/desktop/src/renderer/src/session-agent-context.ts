import type { Agent, Project, Server, Session } from '@spawnea/domain';

// Locate a closing scalar quote, respecting YAML doubled single quotes and double
// quote escapes. No decoding, alias resolution or whole-document parsing occurs.
function closingScalarQuote(text: string, quote: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (quote === '"' && text[index] === '\\') index++;
    else if (text[index] === quote) {
      if (quote === "'" && text[index + 1] === "'") index++;
      else return index;
    }
  }
  return -1;
}

// Bounded structured fields: space-indented mapping/compact sequence keys. Block
// bodies honor modifiers and inferred indentation; plain/quoted continuations
// stay above the key column. Inline properties are lexical only. Preserve line
// endings and preserve text after a closed quoted scalar. Other single-line
// fields retain the existing delimiter-aware masking.
function redactCredentialContinuations(value: string): string {
  const lines = value.split(/(?<=\n)|(?<=\r)(?!\n)/);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = /^([ ]*(?:-[ \t]+)?)(?:"([\w-]+(?:\.[\w-]+)*)"|'([\w-]+(?:\.[\w-]+)*)'|([\w-]+(?:\.[\w-]+)*))[ \t]*:[ \t]*(.*)$/.exec(line.replace(/[\r\n]+$/, ''));
    // Dots qualify a literal label; only its final segment determines sensitivity.
    const key = header && (header[2] ?? header[3] ?? header[4])!.split('.').pop();
    if (!header || !/^(?:[a-z][a-z0-9]*[_-])*[a-z0-9]*(?:password|passwd|token|api[_-]?key|secret[_-]?access[_-]?key|(?:secret|private|access|signing|encryption)[_-]?key|secret|authorization|credential)$/i.test(key!)) {
      result.push(line);
      continue;
    }
    // For "- key", the key column (not the dash column) is the base indentation.
    const prefix = header[1]!;
    const scalar = header[5]!.replace(/^(?:(?:!<[^<>\s]+>|&[^\s,[\]{}]+|![^\s,[\]{}<>]*)(?:[ \t]+|$)){0,2}/, '');
    const block = /^[|>]((?:[1-9][+-]?|[+-][1-9]?)?)[ \t]*(?:#.*)?$/.exec(scalar);
    const modifier = block && /[1-9]/.exec(block[1]!);
    let quote = !block && /^["']/.test(scalar) ? scalar[0] : undefined;
    let closing = quote ? closingScalarQuote(scalar, quote, 1) : -1;
    if (closing >= 0) {
      // Prefer YAML's literal-backslash close before a real neighbor/comment or
      // delimiter. Only whitespace-led value text can extend to a complete
      // legacy escaped-quote close; never search through an ordinary assignment.
      const yamlTail = scalar.slice(closing + 1);
      const escapedClosing = quote === "'" && /(?:^|[^\\])(?:\\\\)*\\$/.test(scalar.slice(0, closing));
      const neighborTail = /^(?:[ \t]*(?:[,;}#]|$)|[ \t]+[a-z][\w-]*(?:\.[\w-]+)*[ \t]*=)/i.test(yamlTail);
      if (escapedClosing && /^[ \t]+\S/.test(yamlTail) && !neighborTail) {
        const legacy = /^'(?:''|\\.|[^'\\\r\n])*'/.exec(scalar);
        if (legacy && /^(?:[ \t,;}]|$)/.test(scalar.slice(legacy[0].length))) {
          closing = legacy[0].length - 1;
        }
      }
      // Structured colon fields use YAML quoting (literal single-quote backslashes),
      // including after lexical properties. Keep delimiters/assignments outside
      // the closing quote. An immediate non-delimiter suffix instead delegates
      // to the legacy backslash-escaped inline syntax, as do equals assignments.
      const tail = scalar.slice(closing + 1);
      const scalarOffset = line.replace(/[\r\n]+$/, '').length - scalar.length;
      // Ordinary quoted values still delegate, preserving specialized markers
      // such as authorization. Only the incompatible lexical forms need this cut.
      const needsLexicalMask = scalar !== header[5] || (quote === "'" && scalar.includes('\\'));
      result.push(needsLexicalMask && /^(?:[ \t,;}]|$)/.test(tail)
        ? `${prefix}[REDACTED CREDENTIAL]${line.slice(scalarOffset + closing + 1)}`
        : line);
      continue;
    }
    let started = Boolean(scalar.trim()) && !scalar.startsWith('#');
    const canStartIndentlessSequence = !block && !started;
    let indentlessSequence = false;
    let hasBody = false;
    let contentIndent = modifier ? prefix.length + Number(modifier[0]) : undefined;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end]!;
      if (next.trim()) {
        const indent = /^ */.exec(next)![0].length;
        // Comments do not dedent an empty-header sequence search or active list.
        // Explicit blocks and nonempty scalars keep their existing boundaries.
        if (canStartIndentlessSequence && (!started || indentlessSequence) && next.trimStart().startsWith('#')) {
          end++;
          continue;
        }
        if (indent <= prefix.length) {
          // Only an empty/comment-only non-block header can own same-column
          // sequence items. Outer entries and nonsequence siblings stay literal.
          if (indent < prefix.length || !canStartIndentlessSequence || (started && !indentlessSequence)) break;
          const item = next.slice(indent);
          if (!/^-(?:[ \t]|[\r\n]|$)/.test(item)) break;
          indentlessSequence = true;
        }
        if (block) {
          contentIndent ??= indent;
          if (indent < contentIndent) break;
        } else if (!started && next.trimStart().startsWith('#')) {
          end++;
          continue;
        }
        hasBody = true;
        let quoteStart = 0;
        if (!block && !started) {
          const first = next.trimStart();
          quote = /^["']/.test(first) ? first[0] : undefined;
          quoteStart = indent + 1;
        }
        started = true;
        const bodyClosing = quote ? closingScalarQuote(next, quote, quoteStart) : -1;
        if (bodyClosing >= 0) {
          // A quoted key or other trailing content is not a scalar terminator.
          // Fall back to indentation-only consumption, without traversing nodes.
          const tail = next.slice(bodyClosing + 1).replace(/[\r\n]+$/, '');
          if (/^[ \t]*(?:#.*)?$/.test(tail)) {
            end++;
            break;
          }
          quote = undefined;
        }
      }
      end++;
    }
    if (!block && !hasBody) {
      result.push(line);
      continue;
    }
    const ending = /(?:\r\n|\r|\n)$/.exec(lines[end - 1]!)?.[0] ?? '';
    result.push(`${prefix}[REDACTED CREDENTIAL]${ending}`);
    index = end - 1;
  }
  return result.join('');
}

// Keep the existing field grammar, but resume at the actual lexical value end
// rather than skipping later fields in a regex match's retained flow tail.
function redactInlineCredentials(source: string): string {
  const fields = /(?<![\w.-])["']?\b(?:[\w-]+\.)*(?:[a-z][a-z0-9]*[_-])*[a-z0-9]*(?:password|passwd|token|api[_-]?key|secret[_-]?access[_-]?key|(?:secret|private|access|signing|encryption)[_-]?key|secret|authorization|credential)\b["']?[ \t]*(?::[ \t]*(?:"(?:\\.|[^"\\\r\n])*"|'(?:''|\\.|[^'\\\r\n])*'|[^\r\n,;}]+?(?=[ \t]+[a-z][\w-]*(?:\.[\w-]+)*[ \t]*=|[\r\n,;}]|$))|=[ \t]*(?:"(?:\\.|[^"\\\r\n])*"|'(?:''|\\.|[^'\\\r\n])*'|[^\s,;}]+))/gi;
  const result: string[] = [];
  let cursor = 0;
  let field: RegExpExecArray | null;
  while ((field = fields.exec(source))) {
    const match = field[0];
    const offset = field.index;
    // Bare colon fields need a line/object/list boundary; quoted keys and
    // equals assignments remain recognizable anywhere, not arbitrary prose.
    const bareColon = /^[\w-]+(?:\.[\w-]+)*[ \t]*:/.test(match);
    const prefix = source.slice(0, offset);
    const fieldBoundary = /(?:^|[\r\n{,;[])[ \t]*$/.test(prefix)
      || /(?:^|[\r\n])[ \t]*-[ \t]+$/.test(prefix);
    if (bareColon && !fieldBoundary) {
      // Reject the prose label, not later recognizable fields its tentative
      // value match may have consumed. The colon guarantees forward progress.
      fields.lastIndex = offset + match.indexOf(':') + 1;
      continue;
    }
    // A same-line open sequence alone gives ] delimiter meaning. Preserve
    // quoted brackets and nonsequence values using the existing lexical cuts.
    const inSequence = /\[[^\]\r\n]*$/.test(prefix);
    const quotedValue = /^["']?[\w.-]+["']?[ \t]*[:=][ \t]*["']/.test(match);
    const close = inSequence && !quotedValue ? match.indexOf(']') : -1;
    result.push(source.slice(cursor, offset), '[REDACTED CREDENTIAL]');
    // Every match includes a nonempty key before a possible ], so this always
    // advances. Revisit only the unconsumed tail, without recursion or rerunning
    // the full redaction pipeline; boundary checks retain original context.
    cursor = offset + (close >= 0 ? close : match.length);
    fields.lastIndex = cursor;
  }
  result.push(source.slice(cursor));
  return result.join('');
}

/** Redaction is best-effort: arbitrary unlabeled secrets cannot be recognized. */
export function redactAgentContextValue(value: string): string {
  const redacted = redactCredentialContinuations(value)
    .replace(/op:\/\/[^\r\n]*/gi, '[REDACTED 1PASSWORD REFERENCE]')
    .replace(/-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 _-]*PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
    .replace(/(?<![\w.-])["']?\b(?:[\w-]+\.)*(?:[a-z][a-z0-9]*[_-])*[a-z0-9]*authorization\b["']?\s*[:=]\s*(?:"(?:Basic|Bearer)\s+[A-Za-z0-9_\-.~+/=]+"|'(?:Basic|Bearer)\s+[A-Za-z0-9_\-.~+/=]+'|(?:Basic|Bearer)\s+[A-Za-z0-9_\-.~+/=]+)/gi, '[REDACTED AUTHORIZATION]')
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
    .replace(/(?<![\w-])(?:sk-[\w-]{8,}|glpat-[\w-]{15,}|github_pat_[\w]+|gh[pousr]_[\w]{15,}|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16})(?![\w-])/g, '[REDACTED TOKEN]');
  return redactInlineCredentials(redacted)
    // Best-effort raw user:password pastes may include unescaped ?/#. A numeric
    // prefix before either is ambiguous with a valid host:port URL: preserve it.
    // Bracketed IPv6 authorities, ordinary query/fragment emails and paths must
    // not become userinfo merely because they contain a later @.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@?#:[\]]+):([^\s/@]+)@/gi, (match, scheme: string, _user: string, password: string) =>
      /^\d+[?#]/.test(password) ? match : `${scheme}[REDACTED]@`)
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
