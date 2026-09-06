const MODEL_FLAGS: Record<string, string> = {
  codex: '-m',
  claude: '--model',
  'claude-code': '--model',
  hermes: '-m',
  antigravity: '--model',
  agy: '--model',
};

export class HarnessLaunchRegistry {
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
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === flag) {
        index += 1;
        continue;
      }
      result.push(args[index]);
    }
    result.push(flag, model);
    return result;
  }
}
