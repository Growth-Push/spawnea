const MODEL_FLAGS: Record<string, string> = {
  codex: '-m',
  claude: '--model',
  'claude-code': '--model',
  hermes: '-m',
  antigravity: '--model',
  agy: '--model',
};

export class HarnessLaunchRegistry {
  promptInput(command: string | undefined, harness: string | undefined, prompt: string): string {
    const name = (harness || command?.split(/[\\/]/).at(-1)?.replace(/\.(?:exe|cmd|bat)$/i, '') || '').toLowerCase();
    const text = prompt.replace(/\r?\n$/, '').replace(/\r$/, '');
    // Known interactive editors support bracketed paste. Keep embedded newlines
    // as text and send the submitting Enter separately after the paste settles.
    return ['codex', 'hermes', 'claude', 'claude-code', 'antigravity', 'agy'].includes(name)
      ? `\x1b[200~${text.split('\x1b[200~').join('').split('\x1b[201~').join('')}\x1b[201~` : text;
  }

  withModel(command: string, harness: string | undefined, args: string[], model: string | undefined): string[] {
    if (!model) return [...args];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,239}$/.test(model)) {
      throw new Error('Model must contain only safe model identifier characters and cannot start with a dash');
    }
    const commandName = (command.split(/[\\/]/).at(-1) ?? command)
      .replace(/\.(?:exe|cmd|bat)$/i, '')
      .toLowerCase();
    const identity = harness?.toLowerCase() || commandName;
    const flag = MODEL_FLAGS[identity] ?? MODEL_FLAGS[commandName];
    if (!flag) throw new Error(`Harness '${identity}' does not support explicit model selection`);

    const result: string[] = [];
    const flags = ['-m', '--model'];
    for (let index = 0; index < args.length; index += 1) {
      if (flags.includes(args[index])) {
        index += 1;
        continue;
      }
      if (flags.some((candidate) => args[index].startsWith(`${candidate}=`))) continue;
      result.push(args[index]);
    }
    result.push(flag, model);
    return result;
  }
}
