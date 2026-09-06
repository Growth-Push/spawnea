import type { CompactOutputResult, HarnessOutputAdapter, OmittedOutputBlock } from './types.js';

export class GenericHarnessOutputAdapter implements HarnessOutputAdapter {
  readonly id: string = 'generic';

  protected classify(_line: string): Omit<OmittedOutputBlock, 'adapter' | 'lineCount'> | undefined {
    return undefined;
  }

  compact(output: string): CompactOutputResult {
    const kept: string[] = [];
    const omitted: OmittedOutputBlock[] = [];
    for (const line of output.split('\n')) {
      const match = this.classify(line);
      if (!match) {
        kept.push(line);
        continue;
      }
      const previous = omitted.at(-1);
      if (previous?.rule === match.rule && previous.category === match.category) previous.lineCount += 1;
      else omitted.push({ adapter: this.id, ...match, lineCount: 1 });
    }
    return { output: kept.join('\n'), omitted };
  }
}
