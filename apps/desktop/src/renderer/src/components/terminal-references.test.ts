import { describe, expect, it, vi } from 'vitest';
import { Terminal as XtermTerminal, type Terminal } from '@xterm/xterm';
import { installReferenceHighlights, MAX_REFERENCE_ROWS, referenceLinkProvider, referencesAtRow, selectedTextFromBuffer, terminalReferenceAtClick } from './terminal-references';

function terminal(lines: Array<{ text: string; wrapped?: boolean }>, cols = 40, viewportY = 0): Terminal {
  const buffer = lines.map(({ text, wrapped }) => {
    const cells: Array<{ getChars: () => string; getWidth: () => number }> = [];
    for (const char of text) {
      const wide = char === '界';
      cells.push({ getChars: () => char, getWidth: () => wide ? 2 : 1 });
      if (wide) cells.push({ getChars: () => '', getWidth: () => 0 });
    }
    return { isWrapped: wrapped, translateToString: () => text, getCell: (x: number) => cells[x] || { getChars: () => '', getWidth: () => 1 } };
  });
  return { cols, rows: 10, buffer: { active: { length: buffer.length, viewportY, getLine: (y: number) => buffer[y] } }, element: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: cols * 10, height: 100 }) }) }, getSelectionPosition: () => undefined } as unknown as Terminal;
}

describe('terminal reference coordinates', () => {
  it('reconstructs real xterm early-wide-wrap padding while preserving explicit spaces', async () => {
    const term = new XtermTerminal({ cols: 11, rows: 3, allowProposedApi: true });
    const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve));
    try {
      await write('https://ab界');
      const firstLine = term.buffer.active.getLine(0)!;
      const wrappedLine = term.buffer.active.getLine(1)!;
      expect(firstLine.translateToString(true)).toBe('https://ab');
      expect(firstLine.getCell(10)?.getChars()).toBe('');
      expect(firstLine.getCell(10)?.getWidth()).toBe(1);
      expect(wrappedLine.isWrapped).toBe(true);
      expect(wrappedLine.getCell(0)?.getChars()).toBe('界');
      expect(selectedTextFromBuffer(term, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe('https://ab界');

      Object.defineProperty(term, 'element', {
        configurable: true,
        value: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 110, height: 30 }) }) },
      });
      const reference = referencesAtRow(term, 0)[0]!;
      expect(reference.text).toBe('https://ab界');
      expect(reference.last).toEqual({ x: 1, y: 1 });
      expect(terminalReferenceAtClick(term, 15, 15)?.text).toBe('https://ab界');

      let linkEnd: unknown;
      referenceLinkProvider(term, vi.fn()).provideLinks(1, (links) => { linkEnd = links?.[0]?.range.end; });
      expect(linkEnd).toEqual({ x: 2, y: 2 });

      const explicitSpace = new XtermTerminal({ cols: 11, rows: 3, allowProposedApi: true });
      try {
        await new Promise<void>((resolve) => explicitSpace.write('https://ab 界', resolve));
        expect(explicitSpace.buffer.active.getLine(0)?.getCell(10)?.getChars()).toBe(' ');
        expect(referencesAtRow(explicitSpace, 0).map(({ text }) => text)).toEqual(['https://ab']);
      } finally {
        explicitSpace.dispose();
      }
    } finally {
      term.dispose();
    }
  });

  it('finds and maps a reference after real xterm cursor-movement padding', async () => {
    const term = new XtermTerminal({ cols: 30, rows: 3, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => term.write('界界界界界\u001b[5Ca.md', resolve));
      const line = term.buffer.active.getLine(0)!;
      expect(line.translateToString(true).length).toBe(14);
      expect(line.getCell(14)?.getChars()).toBe('');
      expect(line.getCell(15)?.getChars()).toBe('a');
      Object.defineProperty(term, 'element', {
        configurable: true,
        value: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 30 }) }) },
      });

      const reference = referencesAtRow(term, 0).find(({ text }) => text === 'a.md');
      expect(reference?.first).toEqual({ x: 15, y: 0 });
      expect(terminalReferenceAtClick(term, 155, 5)?.text).toBe('a.md');
      let linkRange: unknown;
      referenceLinkProvider(term, vi.fn()).provideLinks(1, (links) => { linkRange = links?.find(({ text }) => text === 'a.md')?.range; });
      expect(linkRange).toEqual({ start: { x: 16, y: 1 }, end: { x: 19, y: 1 } });
    } finally {
      term.dispose();
    }
  });

  it('reconstructs selections using real xterm cells for Unicode before and inside the selection', async () => {
    const term = new XtermTerminal({ cols: 30, rows: 3, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => term.write('界e\u0301.md', resolve));
      expect(selectedTextFromBuffer(term, { x: 2, y: 0 }, { x: 5, y: 0 })).toBe('e\u0301.md');
      expect(selectedTextFromBuffer(term, { x: 0, y: 0 }, { x: 5, y: 0 })).toBe('界e\u0301.md');
    } finally {
      term.dispose();
    }
  });
  it('joins a real xterm soft-wrapped path while preserving its explicit space', async () => {
    const term = new XtermTerminal({ cols: 8, rows: 3, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => term.write('my file.md', resolve));
      expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
      expect(selectedTextFromBuffer(term, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe('my file.md');
    } finally {
      term.dispose();
    }
  });
  it('preserves hard breaks, explicit spaces and forward/reverse selection equivalence', async () => {
    const term = new XtermTerminal({ cols: 30, rows: 4, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => term.write('ab  \r\n界 mid\r\nzz', resolve));
      expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false);
      const start = { x: 0, y: 0 };
      const end = { x: 1, y: 2 };
      const forward = selectedTextFromBuffer(term, start, end);
      const reverse = selectedTextFromBuffer(term, end, start);
      expect(forward).toBe('ab  \n界 mid\nzz');
      expect(reverse).toBe(forward);
      expect(selectedTextFromBuffer(term, { x: 5, y: 1 }, { x: 3, y: 1 })).toBe('mid');
    } finally {
      term.dispose();
    }
  });
  it('bounds recognition of a thousand-row wrapped line without returning truncated references', () => {
    const term = terminal(Array.from({ length: 1000 }, (_, i) => ({ text: 'https://example.test/', wrapped: i > 0 })), 40, 500);
    const read = vi.spyOn(term.buffer.active, 'getLine');
    expect(referencesAtRow(term, 500)).toEqual([]);
    expect(read.mock.calls.length).toBeLessThanOrEqual(MAX_REFERENCE_ROWS);
    read.mockClear();
    expect(referencesAtRow(term, 0)).toEqual([]);
    expect(read.mock.calls.length).toBeLessThanOrEqual(MAX_REFERENCE_ROWS + 1);
  });

  it('coalesces overlay events, scans a wrapped line once and preserves unchanged nodes', () => {
    const term = terminal(Array.from({ length: 40 }, (_, i) => ({ text: i ? 'a'.repeat(40) : 'https://' + 'a'.repeat(32), wrapped: i > 0 })), 40);
    Object.assign(term, { rows: 40 });
    const host = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    host.appendChild(screen);
    Object.defineProperty(term, 'element', { value: host });
    let onRender!: () => void;
    let onScroll!: () => void;
    Object.assign(term, {
      onRender: (callback: () => void) => { onRender = callback; return { dispose: vi.fn() }; },
      onScroll: (callback: () => void) => { onScroll = callback; return { dispose: vi.fn() }; },
    });
    const frames: FrameRequestCallback[] = [];
    const request = vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const read = vi.spyOn(term.buffer.active, 'getLine');
    const dispose = installReferenceHighlights(term);
    try {
      onRender(); onRender(); onScroll();
      expect(request).toHaveBeenCalledTimes(1);
      frames.shift()!(0);
      expect(read.mock.calls.length).toBeLessThan(40 * 5);
      const overlay = screen.firstElementChild!;
      expect(overlay.childElementCount).toBe(40);
      const first = overlay.firstChild;
      const create = vi.spyOn(document, 'createElement');
      onRender(); onScroll(); frames.shift()!(0);
      expect(overlay.firstChild).toBe(first);
      expect(create).not.toHaveBeenCalled();
      // A deep viewport in an oversized line is bounded for the whole visible frame.
      Object.assign(term.buffer.active, { length: 1000, viewportY: 500, getLine: vi.fn(() => ({ isWrapped: true })) });
      onRender(); frames.shift()!(0);
      expect(vi.mocked(term.buffer.active.getLine).mock.calls.length).toBeLessThanOrEqual(MAX_REFERENCE_ROWS + term.rows);
      expect(overlay.childElementCount).toBe(0);
      // Do not skip a short normal line following the oversized continuation.
      const normal = terminal([{ text: 'https://example.test' }]).buffer.active.getLine(0);
      Object.assign(term.buffer.active, { getLine: vi.fn((row: number) => row < 502 ? { isWrapped: true } : row === 502 ? normal : undefined) });
      onRender(); frames.shift()!(0);
      expect(overlay.childElementCount).toBe(1);
    } finally {
      dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    }
  });

  it('maps wrapped references across public buffer cells', () => {
    const term = terminal([{ text: 'https://exam' }, { text: 'ple.com/a', wrapped: true }], 12);
    const [reference] = referencesAtRow(term, 1);
    expect(reference.text).toBe('https://example.com/a');
    expect(reference.first).toEqual({ x: 0, y: 0 });
    expect(reference.last).toEqual({ x: 8, y: 1 });
    expect(terminalReferenceAtClick(term, 25, 15)?.text).toBe(reference.text);
  });

  it('includes the second cell of a final wide glyph in wrapped URL hit, link and underline ranges', () => {
    const term = terminal([{ text: 'https://abx' }, { text: '界', wrapped: true }], 11);
    Object.assign(term, { rows: 2 });
    const reference = referencesAtRow(term, 0)[0]!;
    expect(reference.text).toBe('https://abx界');
    expect(reference.last).toEqual({ x: 1, y: 1 });
    expect(terminalReferenceAtClick(term, 15, 15)?.text).toBe(reference.text);

    let linkEnd: unknown;
    let linkDecorations: unknown;
    referenceLinkProvider(term, vi.fn()).provideLinks(1, (value) => {
      linkEnd = value?.[0]?.range.end;
      linkDecorations = value?.[0]?.decorations;
    });
    expect(linkEnd).toEqual({ x: 2, y: 2 });
    expect(linkDecorations).toEqual({ underline: true, pointerCursor: true });

    const screen = document.createElement('div');
    Object.defineProperty(term, 'element', { value: { querySelector: () => screen } });
    Object.assign(term, {
      onRender: (callback: () => void) => { callback(); return { dispose: vi.fn() }; },
      onScroll: () => ({ dispose: vi.fn() }),
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const dispose = installReferenceHighlights(term);
    try {
      const highlights = screen.firstElementChild!;
      expect(highlights.children).toHaveLength(2);
      expect(parseFloat((highlights.children[1] as HTMLElement).style.width) * term.cols / 100).toBeCloseTo(2);
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });

  it('maps Unicode width, multiple targets, punctuation and scrollback', () => {
    const term = terminal([{ text: 'old output' }, { text: '界 a.md https://example.com.' }], 50, 1);
    expect(terminalReferenceAtClick(term, 35, 5)?.text).toBe('a.md');
    expect(terminalReferenceAtClick(term, 85, 5)?.text).toBe('https://example.com');
    expect(terminalReferenceAtClick(term, 5, 5)).toBeNull();
  });

  it('uses only a single reference in a selection under the click, not an unrelated selection', () => {
    const term = terminal([{ text: 'a.md b.md' }]);
    term.getSelectionPosition = () => ({ start: { x: 0, y: 0 }, end: { x: 4, y: 0 } });
    term.getSelection = () => 'a.md';
    expect(terminalReferenceAtClick(term, 65, 5)?.text).toBe('b.md');
    expect(terminalReferenceAtClick(term, 15, 5)?.text).toBe('a.md');
    term.getSelectionPosition = () => ({ start: { x: 0, y: 0 }, end: { x: 9, y: 0 } });
    term.getSelection = () => 'a.md b.md';
    expect(terminalReferenceAtClick(term, 15, 5)).toBeNull();
  });
});
