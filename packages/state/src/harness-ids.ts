/** Alternative names that resolve to a built-in harness id. */
export const HARNESS_ALIASES: ReadonlyMap<string, string> = new Map([
  ['codex-cli', 'codex'],
  ['hermes-python', 'hermes'],
  ['agy', 'antigravity'],
  ['gemini-cli', 'antigravity'],
  ['xai', 'grok'],
  ['claude-code', 'claude'],
]);

/** Lowercases a harness name and resolves built-in aliases. */
export function canonicalHarnessId(name: string): string {
  const normalized = name.toLowerCase().trim();
  return HARNESS_ALIASES.get(normalized) ?? normalized;
}

/**
 * Resolves a harness name or foreground command to one of the known ids.
 * A command path resolves by its basename. Returns undefined when nothing matches.
 */
export function resolveKnownHarnessId(
  name: string | undefined,
  isKnown: (id: string) => boolean
): string | undefined {
  if (!name || !name.trim()) {
    return undefined;
  }
  const exact = canonicalHarnessId(name);
  if (isKnown(exact)) {
    return exact;
  }
  const command = canonicalHarnessId(name.trim().split(/[\\/]/).pop() ?? '');
  return command && isKnown(command) ? command : undefined;
}
