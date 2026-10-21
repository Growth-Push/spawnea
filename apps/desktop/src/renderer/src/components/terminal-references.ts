import type { Terminal, ILinkProvider } from '@xterm/xterm';
import { findReferences, type Reference } from './reference-actions';

export interface CellPosition { x: number; y: number }
export interface TerminalReference extends Reference { first: CellPosition; last: CellPosition }

export function selectedTextFromBuffer(term: Terminal, start: CellPosition, end: CellPosition): string {
  const forward = start.y < end.y || (start.y === end.y && start.x <= end.x);
  const first = forward ? start : end;
  const last = forward ? end : start;
  let text = '';

  for (let y = first.y; y <= last.y; y++) {
    const line = term.buffer.active.getLine(y);
    if (!line) break;
    let fromX = y === first.y ? first.x : 0;
    const toX = y === last.y ? last.x : term.cols - 1;
    if (line.getCell(fromX)?.getWidth() === 0) fromX--;

    let lastOccupiedX = fromX - 1;
    for (let x = fromX; x <= toX; x++) {
      const cell = line.getCell(x);
      if (cell?.getWidth() !== 0 && cell?.getChars()) {
        lastOccupiedX = x + Math.max(cell.getWidth(), 1) - 1;
      }
    }

    for (let x = fromX; x <= Math.min(toX, lastOccupiedX); x++) {
      const cell = line.getCell(x);
      if (cell?.getWidth() === 0) continue;
      text += cell?.getChars() || ' ';
    }

    if (y < last.y && !term.buffer.active.getLine(y + 1)?.isWrapped) text += '\n';
  }
  return text;
}

// Oversized logical lines are deliberately not recognized; never scan unbounded scrollback.
export const MAX_REFERENCE_ROWS = 64;

function scanReferences(term: Terminal, row: number): { references: TerminalReference[]; nextRow: number; oversized?: boolean } {
  const buffer = term.buffer.active;
  let firstRow = row;
  let remaining = MAX_REFERENCE_ROWS;
  while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) {
    if (--remaining === 0) return { references: [], nextRow: row + 1, oversized: true };
    firstRow--;
  }
  let nextRow = row + 1;
  while (nextRow < buffer.length && buffer.getLine(nextRow)?.isWrapped) {
    if (nextRow - firstRow >= MAX_REFERENCE_ROWS) return { references: [], nextRow: nextRow + 1, oversized: true };
    nextRow++;
  }
  return { references: readReferences(term, firstRow, nextRow), nextRow };
}

/** Map UTF-16 text offsets back to public xterm cells, including wide/wrapped text. */
export function referencesAtRow(term: Terminal, row: number): TerminalReference[] {
  return scanReferences(term, row).references;
}

function readReferences(term: Terminal, firstRow: number, nextRow: number): TerminalReference[] {
  const buffer = term.buffer.active;
  let text = '';
  const positions: CellPosition[] = [];
  for (let y = firstRow; y < nextRow; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    const nextLine = buffer.getLine(y + 1);
    const end = nextLine?.isWrapped ? term.cols : occupiedCellEnd(line, term.cols);
    const hasEarlyWideWrapPadding = Boolean(nextLine?.isWrapped && nextLine.getCell(0)?.getWidth() === 2);
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const cellChars = cell.getChars();
      if (x === term.cols - 1 && hasEarlyWideWrapPadding && !cellChars) continue;
      const chars = cellChars || ' ';
      if (x >= end && !cellChars) break;
      text += chars;
      for (let i = 0; i < chars.length; i++) positions.push({ x, y });
    }
  }
  return findReferences(text).map((reference) => {
    const quoted = text[reference.start] === '"' || text[reference.start] === "'";
    const start = reference.start + (quoted ? 1 : 0);
    const first = positions[start];
    const last = positions[start + reference.text.length - 1];
    if (!first || !last) return null;
    const finalCellWidth = buffer.getLine(last.y)?.getCell(last.x)?.getWidth() || 1;
    return { ...reference, first, last: { ...last, x: last.x + finalCellWidth - 1 } };
  }).filter((reference): reference is TerminalReference => reference !== null);
}

function occupiedCellEnd(line: NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>, cols: number): number {
  for (let x = cols - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0 || !cell.getChars()) continue;
    return x + Math.max(cell.getWidth(), 1);
  }
  return 0;
}

export function terminalCellAtClick(term: Terminal, clientX: number, clientY: number): CellPosition | null {
  const screen = term.element?.querySelector('.xterm-screen');
  const rect = screen?.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return null;
  const x = Math.floor((clientX - rect.left) / (rect.width / term.cols));
  const y = Math.floor((clientY - rect.top) / (rect.height / term.rows)) + term.buffer.active.viewportY;
  if (x < 0 || x >= term.cols || y < term.buffer.active.viewportY || y >= term.buffer.active.viewportY + term.rows) return null;
  return { x, y };
}

export function terminalReferenceAtClick(term: Terminal, clientX: number, clientY: number): Reference | null {
  const cell = terminalCellAtClick(term, clientX, clientY);
  if (!cell) return null;
  const { x, y } = cell;
  const selection = term.getSelectionPosition();
  const offset = y * term.cols + x;
  if (selection && offset >= selection.start.y * term.cols + selection.start.x && offset < selection.end.y * term.cols + selection.end.x) {
    const text = term.getSelection().trim();
    const references = findReferences(text, true);
    if (references.length === 1) return references[0];
    return null;
  }
  return referencesAtRow(term, y).find(({ first, last }) => offset >= first.y * term.cols + first.x && offset <= last.y * term.cols + last.x) || null;
}

export function referenceLinkProvider(term: Terminal, openUrl: (url: string) => void): ILinkProvider {
  return { provideLinks(row, callback) {
    callback(referencesAtRow(term, row - 1).map((reference) => ({
      text: reference.text,
      range: { start: { x: reference.first.x + 1, y: reference.first.y + 1 }, end: { x: reference.last.x + 1, y: reference.last.y + 1 } },
      decorations: { underline: true, pointerCursor: true },
      activate(event: MouseEvent) { if (reference.kind === 'url' && (event.ctrlKey || event.metaKey)) openUrl(reference.text); },
    })));
  } };
}

/** Presentation-only underlines; never mutate PTY bytes, selection, or file state. */
export function installReferenceHighlights(term: Terminal): () => void {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return () => {};
  const overlay = document.createElement('div');
  overlay.dataset.testid = 'terminal-reference-highlights';
  Object.assign(overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
  screen.appendChild(overlay);
  let frame: number | null = null;
  let previousSignature = '';
  const render = () => {
    frame = null;
    const segments: Array<[number, number, number]> = [];
    const top = term.buffer.active.viewportY;
    for (let y = top; y < top + term.rows;) {
      const scan = scanReferences(term, y);
      y = scan.nextRow;
      // Skip only wrapped continuation rows; a normal line after a huge line still gets highlighted.
      if (scan.oversized) {
        while (y < top + term.rows && term.buffer.active.getLine(y)?.isWrapped) y++;
      }
      for (const reference of scan.references) {
        for (let row = Math.max(top, reference.first.y); row <= Math.min(top + term.rows - 1, reference.last.y); row++) {
          const start = row === reference.first.y ? reference.first.x : 0;
          const end = row === reference.last.y ? reference.last.x + 1 : term.cols;
          segments.push([row - top, start, end]);
        }
      }
    }
    const signature = `${term.cols}:${term.rows}:${JSON.stringify(segments)}`;
    if (signature !== previousSignature) {
      const fragment = document.createDocumentFragment();
      for (const [row, start, end] of segments) {
        const underline = document.createElement('span');
        Object.assign(underline.style, { position: 'absolute', left: `${100 * start / term.cols}%`, width: `${100 * (end - start) / term.cols}%`, top: `${100 * row / term.rows}%`, height: `${100 / term.rows}%`, borderBottom: '1px solid #79c0ff', boxSizing: 'border-box' });
        fragment.appendChild(underline);
      }
      overlay.replaceChildren(fragment);
      previousSignature = signature;
    }
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(render); };
  const renderListener = term.onRender(schedule);
  const scrollListener = term.onScroll(schedule);
  schedule();
  return () => { renderListener.dispose(); scrollListener.dispose(); if (frame !== null) cancelAnimationFrame(frame); overlay.remove(); };
}
