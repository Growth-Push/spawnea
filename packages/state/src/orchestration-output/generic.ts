import type { CompactOutputResult, HarnessOutputAdapter, OmittedOutputBlock } from './types.js';

export class GenericHarnessOutputAdapter implements HarnessOutputAdapter {
  readonly id: string = 'generic';

  protected classify(_line: string): Omit<OmittedOutputBlock, 'adapter' | 'lineCount'> | undefined {
    return undefined;
  }

  compact(output: string): CompactOutputResult {
    const kept: string[] = [];
    const omitted: OmittedOutputBlock[] = [];
    let previous: OmittedOutputBlock | undefined;
    for (const line of output.split('\n')) {
      const match = this.classify(line);
      if (!match) {
        kept.push(line);
        previous = undefined;
        continue;
      }
      if (previous?.rule === match.rule && previous.category === match.category) previous.lineCount += 1;
      else {
        previous = { adapter: this.id, ...match, lineCount: 1 };
        omitted.push(previous);
      }
    }
    return { output: kept.join('\n'), omitted };
  }
}
