export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,239}$/;

const ROOT_MODEL_FLAGS: Readonly<Record<string, '-m' | '--model'>> = {
  codex: '-m',
  claude: '--model',
  'claude-code': '--model',
  hermes: '-m',
};

export function normalizeHarnessExecutable(command: string): string {
  return (command.split(/[\\/]/).at(-1) ?? command)
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase();
}

/** Root model capability belongs to the executable, not profile/display metadata. */
export function getRootModelFlag(command: string): '-m' | '--model' | undefined {
  const executable = normalizeHarnessExecutable(command);
  return Object.hasOwn(ROOT_MODEL_FLAGS, executable) ? ROOT_MODEL_FLAGS[executable] : undefined;
}
