import { getRootModelFlag, MODEL_ID_PATTERN, normalizeHarnessExecutable } from '@spawnea/domain';

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

  withModel(command: string, harness: string | undefined, args: string[], model: string | undefined, allowExtendedHarness = false): string[] {
    if (model === undefined) return [...args];
    if (!MODEL_ID_PATTERN.test(model)) {
      throw new Error('Model must contain only safe model identifier characters and cannot start with a dash');
    }
    const commandName = normalizeHarnessExecutable(command);
    // Keep existing child mappings; root capability requires a known executable.
    const identity = allowExtendedHarness
      ? (MODEL_FLAGS[commandName] ? commandName : harness?.toLowerCase() || commandName)
      : commandName;
    const flag = allowExtendedHarness ? MODEL_FLAGS[identity] : getRootModelFlag(command);
    if (!flag) {
      throw new Error(`Harness '${identity}' does not support explicit model selection`);
    }

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

  withSessionId(command: string, _harness: string | undefined, args: string[], sessionId: string): string[] {
    const commandName = normalizeHarnessExecutable(command);
    if (commandName !== 'claude' && commandName !== 'claude-code') {
      return [...args];
    }
    const doubleDashIndex = args.indexOf('--');
    const optionsSlice = doubleDashIndex !== -1 ? args.slice(0, doubleDashIndex) : args;

    for (let index = 0; index < optionsSlice.length; index += 1) {
      if (optionsSlice[index] === '--session-id' || optionsSlice[index].startsWith('--session-id=')) {
        return [...args];
      }
    }
    const hasResumeOrContinue = optionsSlice.some(
      (arg) =>
        arg === '--continue' ||
        arg === '-c' ||
        arg === '--resume' ||
        arg.startsWith('--resume=') ||
        (arg.startsWith('-r') && !arg.startsWith('--'))
    );
    const hasForkSession = optionsSlice.includes('--fork-session');
    if (hasResumeOrContinue && !hasForkSession) {
      return [...args];
    }
    if (doubleDashIndex !== -1) {
      return [...args.slice(0, doubleDashIndex), '--session-id', sessionId, ...args.slice(doubleDashIndex)];
    }
    return [...args, '--session-id', sessionId];
  }
}
