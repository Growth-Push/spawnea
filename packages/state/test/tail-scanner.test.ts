import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findCodexTailExchangeOffset,
  findTailExchangeOffset,
  MAX_TAIL_RECORD_BYTES,
  type UserPromptCheck,
} from '../src/history/tail-scanner.js';

describe('tail-scanner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-scanner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const isUserPrompt: UserPromptCheck = (rec) => {
    return rec.type === 'user_prompt';
  };

  it('locates target exchanges in a standard JSONL file', () => {
    expect(MAX_TAIL_RECORD_BYTES).toBe(4 * 1024 * 1024);
    const file = path.join(tempDir, 'standard.jsonl');
    const records = [
      { type: 'user_prompt', content: 'prompt 1' },
      { type: 'assistant_msg', content: 'reply 1' },
      { type: 'user_prompt', content: 'prompt 2' },
      { type: 'assistant_msg', content: 'reply 2' },
      { type: 'user_prompt', content: 'prompt 3' },
      { type: 'assistant_msg', content: 'reply 3' },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      // Last 1 exchange -> prompt 3
      const off1 = findTailExchangeOffset(fd, stat.size, isUserPrompt, 1);
      expect(off1).toBeGreaterThan(0);
      const prompt3Offset = Buffer.byteLength(
        records.slice(0, 4).map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8'
      );
      expect(off1).toBe(prompt3Offset);

      // Last 2 exchanges -> prompt 2
      const off2 = findTailExchangeOffset(fd, stat.size, isUserPrompt, 2);
      const prompt2Offset = Buffer.byteLength(
        records.slice(0, 2).map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8'
      );
      expect(off2).toBe(prompt2Offset);

      // Last 3 exchanges -> prompt 1 (at offset 0)
      const off3 = findTailExchangeOffset(fd, stat.size, isUserPrompt, 3);
      expect(off3).toBe(0);

      // More than available -> returns 0
      const off5 = findTailExchangeOffset(fd, stat.size, isUserPrompt, 5);
      expect(off5).toBe(0);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('skips a multi-MiB record (> 4 MiB) as a whole without quadratic copy amplification or parsing it', () => {
    const file = path.join(tempDir, 'multi-mib-record.jsonl');

    // Create prompt 1
    const p1 = JSON.stringify({ type: 'user_prompt', content: 'prompt 1' }) + '\n';
    const r1 = JSON.stringify({ type: 'assistant_msg', content: 'reply 1' }) + '\n';

    // Create an oversized record (> 4 MiB, e.g. 4.5 MiB = 4718592 bytes)
    const giantPayload = 'x'.repeat(4.5 * 1024 * 1024);
    const giantRecord = JSON.stringify({ type: 'user_prompt', content: giantPayload }) + '\n';

    // Create prompt 2 and reply 2
    const p2 = JSON.stringify({ type: 'user_prompt', content: 'prompt 2' }) + '\n';
    const r2 = JSON.stringify({ type: 'assistant_msg', content: 'reply 2' }) + '\n';

    const p1Offset = 0;
    const p2Offset = Buffer.byteLength(p1 + r1 + giantRecord, 'utf8');

    const fdWrite = fs.openSync(file, 'w');
    fs.writeSync(fdWrite, Buffer.from(p1, 'utf8'));
    fs.writeSync(fdWrite, Buffer.from(r1, 'utf8'));
    fs.writeSync(fdWrite, Buffer.from(giantRecord, 'utf8'));
    fs.writeSync(fdWrite, Buffer.from(p2, 'utf8'));
    fs.writeSync(fdWrite, Buffer.from(r2, 'utf8'));
    fs.closeSync(fdWrite);

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      expect(stat.size).toBeGreaterThan(4.5 * 1024 * 1024);

      // Scan for 1 exchange: should find prompt 2
      const off1 = findTailExchangeOffset(fd, stat.size, isUserPrompt, 1);
      expect(off1).toBe(p2Offset);

      // Scan for 2 exchanges: skips the multi-MiB record (even though it had type user_prompt)
      // and reaches prompt 1 at offset 0
      const off2 = findTailExchangeOffset(fd, stat.size, isUserPrompt, 2);
      expect(off2).toBe(p1Offset);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('drops accumulated fragments immediately once cap is exceeded and keeps retained memory bounded for records far above cap', () => {
    const file = path.join(tempDir, 'far-above-cap.jsonl');

    const p1 = JSON.stringify({ type: 'user_prompt', content: 'prompt 1' }) + '\n';

    // Create a 16 MiB line (4x the 4 MiB cap)
    const giantChunk = 'y'.repeat(1024 * 1024); // 1 MiB chunk
    const fdWrite = fs.openSync(file, 'w');
    fs.writeSync(fdWrite, Buffer.from(p1, 'utf8'));

    // Write start of giant line
    fs.writeSync(fdWrite, Buffer.from('{"type":"assistant_msg","content":"', 'utf8'));
    for (let i = 0; i < 16; i++) {
      fs.writeSync(fdWrite, Buffer.from(giantChunk, 'utf8'));
    }
    fs.writeSync(fdWrite, Buffer.from('"}\n', 'utf8'));

    // Create prompt 2
    const p2 = JSON.stringify({ type: 'user_prompt', content: 'prompt 2' }) + '\n';
    fs.writeSync(fdWrite, Buffer.from(p2, 'utf8'));
    fs.closeSync(fdWrite);

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      expect(stat.size).toBeGreaterThan(16 * 1024 * 1024);

      let maxTrailingBytes = 0;
      let maxTrailingFragments = 0;
      const fragmentsAfterCapExceeded: number[] = [];

      const targetOffset = findTailExchangeOffset(
        fd,
        stat.size,
        isUserPrompt,
        2,
        64 * 1024,
        (stats) => {
          maxTrailingBytes = Math.max(maxTrailingBytes, stats.trailingBytes);
          maxTrailingFragments = Math.max(maxTrailingFragments, stats.trailingFragmentsCount);
          if (stats.recordTooLarge) {
            fragmentsAfterCapExceeded.push(stats.trailingFragmentsCount);
          }
        },
        32 * 1024 * 1024
      );

      // Reaches prompt 1 at offset 0
      expect(targetOffset).toBe(0);

      // Memory retained never exceeded MAX_TAIL_RECORD_BYTES
      expect(maxTrailingBytes).toBeLessThanOrEqual(MAX_TAIL_RECORD_BYTES);

      // Once recordTooLarge was triggered, fragments were immediately dropped and stayed 0
      expect(fragmentsAfterCapExceeded.length).toBeGreaterThan(100);
      for (const count of fragmentsAfterCapExceeded) {
        expect(count).toBe(0);
      }
    } finally {
      fs.closeSync(fd);
    }
  });

  it('findCodexTailExchangeOffset stops when event offsets reach N in a paired rollout', () => {
    const file = path.join(tempDir, 'codex-paired.jsonl');
    const records = [];
    for (let i = 1; i <= 10; i++) {
      records.push({ type: 'event_msg', payload: { type: 'user_message', message: `p${i}` } });
      records.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: `p${i}` } });
      records.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: `a${i}` } });
    }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const isEvent: UserPromptCheck = (r) => r.type === 'event_msg';
      const isResponse: UserPromptCheck = (r) => r.type === 'response_item' && (r.payload as any)?.role === 'user';

      const off = findCodexTailExchangeOffset(fd, stat.size, isEvent, isResponse, 2);
      expect(off).toBeGreaterThan(0);

      // Byte offset of exchange 9's event_msg
      const expectedOffset = Buffer.byteLength(
        records.slice(0, 24).map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8'
      );
      expect(off).toBe(expectedOffset);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('findCodexTailExchangeOffset stops when response offsets reach N when no events exist', () => {
    const file = path.join(tempDir, 'codex-response-only.jsonl');
    const records = [];
    for (let i = 1; i <= 10; i++) {
      records.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: `p${i}` } });
      records.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: `a${i}` } });
    }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const isEvent: UserPromptCheck = (r) => r.type === 'event_msg';
      const isResponse: UserPromptCheck = (r) => r.type === 'response_item' && (r.payload as any)?.role === 'user';

      const off = findCodexTailExchangeOffset(fd, stat.size, isEvent, isResponse, 2);
      expect(off).toBeGreaterThan(0);

      // Byte offset of exchange 9's response_item user
      const expectedOffset = Buffer.byteLength(
        records.slice(0, 16).map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8'
      );
      expect(off).toBe(expectedOffset);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('returns -1 when no records match the user prompt predicate', () => {
    const file = path.join(tempDir, 'no-prompts.jsonl');
    const records = [
      { type: 'system', content: 'init' },
      { type: 'assistant_msg', content: 'reply' },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const off = findTailExchangeOffset(fd, stat.size, isUserPrompt, 1);
      expect(off).toBe(-1);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('bounds the backward scan when maxScanBytes budget is reached', () => {
    const file = path.join(tempDir, 'budget.jsonl');
    // Write 5 exchanges with 10 KB padding between them
    const records = [];
    for (let i = 1; i <= 5; i++) {
      records.push({ type: 'user_prompt', content: `prompt ${i}` });
      records.push({ type: 'assistant_msg', content: 'x'.repeat(10 * 1024) });
    }
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      // Scan with small budget (15 KB): will find prompt 5, but budget will be exhausted before prompt 4
      const off = findTailExchangeOffset(fd, stat.size, isUserPrompt, 5, 4096, undefined, 15 * 1024);
      // Returns earliest prompt found within the budget (prompt 5)
      const prompt5Offset = Buffer.byteLength(
        records.slice(0, 8).map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8'
      );
      expect(off).toBe(prompt5Offset);

      // If budget is exhausted with no prompts found (e.g. 5 KB budget from tail of assistant_msg)
      const isEarlyPrompt: UserPromptCheck = (r) => r.type === 'user_prompt' && r.content === 'prompt 1';
      const offNoMatch = findTailExchangeOffset(fd, stat.size, isEarlyPrompt, 1, 4096, undefined, 5 * 1024);
      // Returns budget boundary
      expect(offNoMatch).toBeGreaterThan(0);
      expect(offNoMatch).toBe(stat.size - 4096 * 2); // 2 chunks of 4096 = 8192 >= 5120
    } finally {
      fs.closeSync(fd);
    }
  });

  it('handles empty file correctly', () => {
    const file = path.join(tempDir, 'empty.jsonl');
    fs.writeFileSync(file, '');

    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const off = findTailExchangeOffset(fd, stat.size, isUserPrompt, 1);
      expect(off).toBe(0);
    } finally {
      fs.closeSync(fd);
    }
  });
});
