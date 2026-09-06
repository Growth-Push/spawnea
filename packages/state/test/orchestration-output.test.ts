import { describe, expect, it } from 'vitest';
import { resolveHarnessOutputAdapter } from '../src/orchestration-output/registry.js';

describe('orchestration output adapters', () => {
  it('keeps unknown Codex output and reports recognized progress omissions', () => {
    const result = resolveHarnessOutputAdapter('codex').compact(
      '⠋ Reading files\nShould I update the documentation?\nFinding: unsafe input'
    );
    expect(result.output).toBe('Should I update the documentation?\nFinding: unsafe input');
    expect(result.omitted).toEqual([
      { adapter: 'codex', rule: 'spinner', category: 'progress', lineCount: 1 },
    ]);
  });

  it('maps agy to Antigravity and preserves unclassified content', () => {
    const result = resolveHarnessOutputAdapter('agy').compact('Searching repository...\nUnusual output');
    expect(result.output).toBe('Unusual output');
    expect(result.omitted[0]).toMatchObject({ adapter: 'antigravity', rule: 'tool-progress' });
  });

  it('uses a conservative generic adapter for unknown harnesses', () => {
    const output = 'Spinner-like text...\nQuestion?';
    expect(resolveHarnessOutputAdapter('unknown').compact(output)).toEqual({ output, omitted: [] });
  });
});
