import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Session } from '@spawnea/domain';
import { ActivityChart, DashboardView } from './DashboardView';
import { HistoryChart } from './ActivityChart';
import { appendActivity, countWorking, MAX_SAMPLES, sessionForest } from './session-overview';

const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, name: id, task: `Task ${id}`, serverId: 'host', projectId: 'project', agentId: 'agent', branch: 'main', worktreePath: '/workspace/example', tmuxSessionName: id, status: 'working', createdAt: new Date(0), lastActivityAt: new Date(0), ...patch });
const props = { servers: [], projects: [], agents: [], activeSessionId: null, onSelectSession: vi.fn(), onReturn: vi.fn(), samples: [], startedAt: 0, isLoading: false };
const setScreenTransform = (chart: Element, scale: number, left: number, top: number) => {
  Object.defineProperty(chart, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => ({ a: 1 / scale, d: 1 / scale, e: -left / scale, f: -top / scale }) }) });
  Object.defineProperty(chart, 'createSVGPoint', { configurable: true, value: () => ({
    x: 0, y: 0,
    matrixTransform(matrix: { a: number; d: number; e: number; f: number }) { return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f }; },
  }) });
};
const movePointer = (chart: Element, x: number, y = 0) => {
  const pointer = new Event('pointermove', { bubbles: true });
  Object.defineProperties(pointer, { clientX: { value: x }, clientY: { value: y } });
  fireEvent(chart, pointer);
};
afterEach(cleanup);
describe('Dashboard', () => {
  it('retains ancestry under attention filtering and attributes cross-host children to their real host', () => {
    const root = session('root', { status: 'idle' });
    const child = session('child', { parentSessionId: 'root', serverId: 'remote', projectId: 'other', status: 'needs_input' });
    render(<DashboardView {...props} sessions={[root, child]} />);
    fireEvent.click(screen.getByLabelText('Needs attention'));
    expect(screen.getByRole('button', { name: 'root' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'child' }));
    expect(props.onSelectSession).toHaveBeenCalledWith('child');
    fireEvent.change(screen.getByLabelText('Distribution group'), { target: { value: 'Host' } });
    expect(screen.getByText('Unavailable host (remote): 1', { selector: 'li' })).toBeTruthy();
    expect(screen.getByText(/All current sessions: 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return to workspace' }));
    expect(props.onReturn).toHaveBeenCalled();
  });
  it('renders orphan fallback, live changes, and empty states', () => {
    const view = render(<DashboardView {...props} sessions={[session('orphan', { parentSessionId: 'missing' })]} />);
    expect(screen.getByText('Missing parent')).toBeTruthy();
    view.rerender(<DashboardView {...props} sessions={[]} />);
    expect(screen.getByText('No matching sessions')).toBeTruthy();
    expect(screen.getByText('No sessions to distribute')).toBeTruthy();
  });
  it('renders each row once in representative larger layouts', () => {
    const sessions = Array.from({ length: 60 }, (_, i) => session(`session-${i}`, { serverId: `host-${i % 3}`, projectId: `project-${i % 5}`, parentSessionId: i % 2 ? `session-${i - 1}` : undefined }));
    render(<DashboardView {...props} sessions={sessions} />);
    for (const s of sessions) expect(screen.getAllByText(s.name, { selector: 'button' })).toHaveLength(1);
    expect(screen.getByText(/All current sessions: 60/)).toBeTruthy();
  });
  it('renders deeply nested descendants and counts grandchildren under host', () => {
    const parent = session('p1');
    const child = session('c1', { parentSessionId: 'p1' });
    const grandchild = session('g1', { parentSessionId: 'c1' });
    render(<DashboardView {...props} sessions={[parent, child, grandchild]} />);
    expect(screen.getByText('1 projects · 3 sessions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'g1' })).toBeTruthy();
  });
  it('copies only the requested session details and reports clipboard errors', async () => {
    const writeClipboardText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('clipboard unavailable'));
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { writeClipboardText } });
    render(<DashboardView {...props} sessions={[session('example', { tmuxWindowName: 'agent' })]} />);
    expect(screen.getByText('tmux: example:agent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy example details' }));
    expect(writeClipboardText).toHaveBeenCalledWith('Name: example\nID: example\nHost: Unavailable host (host)\nProject: Unavailable project (project)\nHarness: Unavailable harness (agent)\nState: working\nBranch: main\nWorktree: /workspace/example\ntmux: example:agent');
    await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Copy example details' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Copy example details' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not copy session example.');
  });

  it('copies the filtered tree in UI group order, with contextual ancestors and collapsed branches', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { writeClipboardText } });
    const sessions = [
      session('z-root', { name: 'needle z', status: 'error' }),
      session('b-root', { name: 'needle b', serverId: 'remote', projectId: 'other', status: 'error' }),
      session('a-root', { name: 'a context', status: 'idle' }),
      session('d-root', { name: 'needle d', projectId: 'second', status: 'needs_input' }),
      session('c-root', { name: 'needle c', serverId: 'remote', projectId: 'third' }),
      session('child', { parentSessionId: 'a-root', status: 'idle' }),
      session('leaf', { name: 'needle leaf', parentSessionId: 'child', serverId: 'remote', projectId: 'other', status: 'needs_input' }),
      session('excluded', { parentSessionId: 'a-root', status: 'error' }),
    ];
    const view = render(<DashboardView {...props} sessions={sessions} />);
    const displayedIds = screen.getAllByRole('button').flatMap((button) => sessions.filter((s) => button.textContent === s.name).map((s) => s.id));
    expect(displayedIds).toEqual(['a-root', 'child', 'leaf', 'excluded', 'z-root', 'd-root', 'b-root', 'c-root']);
    const copyButton = screen.getByRole('button', { name: 'Copy table' });
    fireEvent.click(copyButton);
    await screen.findByText('Table copied.');
    const exportedRows = () => (writeClipboardText.mock.lastCall![0] as string).split('\r\n').slice(1).map((row) => row.split('\t'));
    expect(exportedRows().map((row) => row[1])).toEqual(displayedIds);
    expect(exportedRows().find((row) => row[1] === 'leaf')?.slice(2, 5)).toEqual(['child', 'Unavailable host (remote)', 'Unavailable project (other)']);
    expect(writeClipboardText.mock.lastCall![0]).not.toContain('Task ');

    fireEvent.click(screen.getByLabelText('Needs attention'));
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: /Unavailable project \(project\).*2 root sessions/ }));
    fireEvent.click(screen.getByRole('button', { name: /Unavailable host \(remote\).*1 projects/ }));
    expect(screen.queryByRole('button', { name: 'needle leaf' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'needle b' })).toBeNull();
    fireEvent.click(copyButton);
    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(2));
    await screen.findByText('Table copied.');
    expect(exportedRows().map((row) => row[1])).toEqual(['a-root', 'child', 'leaf', 'z-root', 'd-root', 'b-root']);

    view.rerender(<DashboardView {...props} sessions={sessions.map((s) => s.id === 'leaf' ? { ...s, name: 'needle updated' } : s)} />);
    fireEvent.click(copyButton);
    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(3));
    expect(exportedRows().find((row) => row[1] === 'leaf')?.[0]).toBe('needle updated');
  });

  it('exports duplicates, orphan parents and cyclic parent IDs once without rewriting relationships', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { writeClipboardText } });
    render(<DashboardView {...props} sessions={[
      session('b', { parentSessionId: 'a' }), session('a', { parentSessionId: 'b' }),
      session('a', { parentSessionId: 'b' }), session('orphan', { parentSessionId: 'missing' }),
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    await screen.findByText('Table copied.');
    const rows = (writeClipboardText.mock.lastCall![0] as string).split('\r\n').slice(1).map((row) => row.split('\t'));
    expect(rows.map((row) => row.slice(1, 3))).toEqual([['a', 'b'], ['b', 'a'], ['orphan', 'missing']]);
  });

  it('disables table export while loading or without filtered rows', () => {
    const writeClipboardText = vi.fn();
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { writeClipboardText } });
    const view = render(<DashboardView {...props} isLoading sessions={[session('a')]} />);
    const copyButton = screen.getByRole('button', { name: 'Copy table' }) as HTMLButtonElement;
    expect(copyButton.disabled).toBe(true);
    fireEvent.click(copyButton);
    view.rerender(<DashboardView {...props} sessions={[]} />);
    expect(copyButton.disabled).toBe(true);
    fireEvent.click(copyButton);
    view.rerender(<DashboardView {...props} sessions={[session('a')]} />);
    expect(copyButton.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'unmatched' } });
    expect(copyButton.disabled).toBe(true);
    fireEvent.click(copyButton);
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it('announces table success only after clipboard completion and clears recoverable errors on success', async () => {
    let resolveCopy!: () => void;
    const writeClipboardText = vi.fn().mockRejectedValueOnce(new Error('clipboard unavailable')).mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { writeClipboardText } });
    render(<DashboardView {...props} sessions={[session('example')]} />);
    const copyButton = screen.getByRole('button', { name: 'Copy table' }) as HTMLButtonElement;
    fireEvent.click(copyButton);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not copy session table. Please try again.');
    expect(screen.queryByText('Table copied.')).toBeNull();
    expect(copyButton.disabled).toBe(false);
    fireEvent.click(copyButton);
    expect(copyButton.disabled).toBe(true);
    expect(screen.queryByText('Table copied.')).toBeNull();
    fireEvent.click(copyButton);
    fireEvent.click(screen.getByRole('button', { name: 'Copy example details' }));
    expect(writeClipboardText).toHaveBeenCalledTimes(2);
    await act(async () => resolveCopy());
    expect(screen.getByRole('status').textContent).toBe('Table copied.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(copyButton.disabled).toBe(false);
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard unavailable again'));
    fireEvent.click(copyButton);
    expect(screen.queryByText('Table copied.')).toBeNull();
    await screen.findByRole('alert');
    expect(screen.queryByText('Table copied.')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('ignores late clipboard %s after unmount and keeps a new Dashboard independent', async (outcome) => {
    let resolveCopy!: () => void;
    let rejectCopy!: (error: Error) => void;
    const writeClipboardText = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveCopy = resolve; rejectCopy = reject; }));
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { writeClipboardText } });
    const view = render(<DashboardView {...props} sessions={[session('example')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    view.unmount();
    render(<DashboardView {...props} sessions={[session('next')]} />);
    await act(async () => { if (outcome === 'resolve') resolveCopy(); else rejectCopy(new Error('late failure')); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Table copied.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Copy table' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
describe('Aggregate observations', () => {
  it('preserves the selected observation across a live refresh and resets on range changes', () => {
    const a = { time: 1000, parents: 1, children: 0, gap: false };
    const b = { time: 5000, parents: 2, children: 0, gap: false };
    const c = { time: 10000, parents: 3, children: 0, gap: false };
    const view = render(<ActivityChart samples={[a, b, c]} startedAt={0} />);
    fireEvent.change(screen.getByLabelText('Activity observation'), { target: { value: '1' } });
    view.rerender(<ActivityChart samples={[a, { ...a, time: 2000 }, b, c, { ...c, time: 15000 }]} startedAt={0} />);
    expect(screen.getByText(/Parents: 2 · Children: 0/)).toBeTruthy();
    expect((screen.getByLabelText('Activity observation') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Full range' }));
    expect((screen.getByLabelText('Activity observation') as HTMLInputElement).value).toBe('0');
  });
  it('preserves selection among observations sharing a timestamp', () => {
    const samples = [{ time: 1000, parents: 1, children: 0, gap: true }, { time: 1000, parents: 2, children: 0, gap: false }];
    const view = render(<ActivityChart samples={samples} startedAt={0} />);
    fireEvent.change(screen.getByLabelText('Activity observation'), { target: { value: '1' } });
    view.rerender(<ActivityChart samples={[...samples, { time: 2000, parents: 3, children: 0, gap: false }]} startedAt={0} />);
    expect(screen.getByText(/Parents: 2 · Children: 0/)).toBeTruthy();
    expect((screen.getByLabelText('Activity observation') as HTMLInputElement).value).toBe('1');
  });
  it('keeps page errors visible through overview refresh and retries explicitly', async () => {
    const getDashboardHistory = vi.fn().mockResolvedValue({ first: 1000, last: 11000, closedCount: 2, points: [] });
    const getDashboardHistoryPage = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ observations: [{ id: 1, time: 1000, parents: 2, children: 1, gap: false }], next: null });
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { getDashboardHistory, getDashboardHistoryPage } });
    const view = render(<HistoryChart revision={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Browse observations in this range' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load dashboard observations.');
    view.rerender(<HistoryChart revision={1} />);
    await vi.waitFor(() => expect(getDashboardHistory).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert').textContent).toContain('Could not load dashboard observations.');
    expect(screen.queryByText(/Observations \(loading\)/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry observations' }));
    expect(await screen.findByRole('list', { name: 'Observed activity records' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('requests persisted detail on zoom and restores the full range', async () => {
    const getDashboardHistory = vi.fn().mockResolvedValue({ first: 1000, last: 11000, closedCount: 2, points: [
      { time: 1000, parents: 1, children: 0, gap: false, summarized: true, containsGap: false },
      { time: 11000, parents: 2, children: 1, gap: false, summarized: false, containsGap: false },
    ] });
    const getDashboardHistoryPage = vi.fn().mockResolvedValueOnce({ observations: [{ id: 1, time: 1000, parents: 1, children: 0, gap: false }], next: { id: 1, time: 1000 } }).mockResolvedValueOnce({ observations: [{ id: 2, time: 1000, parents: 2, children: 0, gap: false }], next: null });
    Object.defineProperty(window, 'spawneaApi', { configurable: true, value: { getDashboardHistory, getDashboardHistoryPage } });
    render(<HistoryChart revision={0} />);
    expect(await screen.findByText(/Closed sessions since history was enabled: 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await vi.waitFor(() => expect(getDashboardHistory).toHaveBeenLastCalledWith({ from: 3500, to: 8500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Full range' }));
    await vi.waitFor(() => expect(getDashboardHistory).toHaveBeenLastCalledWith(undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Browse observations in this range' }));
    await screen.findByRole('list', { name: 'Observed activity records' });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await vi.waitFor(() => expect(getDashboardHistoryPage).toHaveBeenLastCalledWith({ from: 1000, to: 11000 }, { id: 1, time: 1000 }));
  });
  it('navigates observations with pointer and keyboard accessible controls', () => {
    const samples = [
      { time: 0, parents: 1, children: 2, gap: false },
      { time: 10_000, parents: 0, children: 0, gap: true },
      { time: 20_000, parents: 3, children: 4, gap: false },
    ];
    render(<ActivityChart samples={samples} startedAt={0} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    setScreenTransform(chart, 1, 0, 0);
    movePointer(chart, 465);
    expect(screen.getByText(/Parents: 3 · Children: 4/)).toBeTruthy();
    const slider = screen.getByLabelText('Activity observation');
    fireEvent.change(slider, { target: { value: '1' } });
    expect(screen.getByText(/Unobserved period/)).toBeTruthy();
    fireEvent.change(slider, { target: { value: '2' } });
    expect(screen.getByText(/Parents: 3 · Children: 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Full range' }));
    expect((slider as HTMLInputElement).max).toBe('2');
  });
  it.each([
    { name: 'matching aspect ratio', scale: 2, left: 0, top: 0 },
    { name: 'wide letterboxed element', scale: 192 / 170, left: (1000 - 500 * 192 / 170) / 2, top: 0 },
  ])('maps pointer coordinates for $name', ({ scale, left, top }) => {
    const samples = [
      { time: 0, parents: 1, children: 0, gap: false },
      { time: 16_000, parents: 2, children: 0, gap: false },
      { time: 20_000, parents: 3, children: 4, gap: false },
    ];
    render(<ActivityChart samples={samples} startedAt={0} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    setScreenTransform(chart, scale, left, top);
    movePointer(chart, left + 465 * scale, top + 85 * scale);
    expect(screen.getByText(/Parents: 3 · Children: 4/)).toBeTruthy();
  });
  it('ignores a pointer when its SVG transform is unavailable or non-invertible', () => {
    render(<ActivityChart samples={[{ time: 0, parents: 1, children: 0, gap: false }, { time: 10_000, parents: 2, children: 0, gap: false }]} startedAt={0} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    Object.defineProperty(chart, 'getScreenCTM', { configurable: true, value: () => null });
    movePointer(chart, 465);
    expect(screen.getByText(/Parents: 1 · Children: 0/)).toBeTruthy();
    setScreenTransform(chart, 1, 0, 0);
    Object.defineProperty(chart, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => { throw new Error('non-invertible'); } }) });
    movePointer(chart, 465);
    expect(screen.getByText(/Parents: 1 · Children: 0/)).toBeTruthy();
  });
  it('classifies roots without children, children, promotion and deletion without rewriting history', () => {
    const root = session('root'); const child = session('child', { parentSessionId: 'root' });
    const startingRoot = session('starting-root', { status: 'starting' });
    expect(countWorking([startingRoot])).toEqual({ parents: 1, children: 0 });
    const first = appendActivity([], [root, child, child], 0, true);
    expect(first[0]).toMatchObject({ parents: 1, children: 1 });
    const next = appendActivity(first, [{ ...child, parentSessionId: undefined }], 10_000, true);
    expect(next[1]).toMatchObject({ parents: 1, children: 0 });
    expect(next[0]).toEqual(first[0]);
    expect(appendActivity(next, [], 20_000, true)[2].parents).toBe(0);
  });
  it('marks unavailable periods and delayed timers as gaps, bounds memory, and starts fresh', () => {
    let samples = appendActivity([], [], 0, false);
    samples = appendActivity(samples, [], 30_000, true);
    expect(samples.map((s) => s.gap)).toEqual([true, false]);
    samples = appendActivity(samples, [], 40_000, true);
    expect(samples[2].gap).toBe(false);
    const delayed = appendActivity([samples[2]], [session('later')], 80_000, true);
    expect(delayed.slice(1).map((s) => s.gap)).toEqual([true, false]);
    expect(delayed[2].parents).toBe(1);
    for (let i = 0; i < MAX_SAMPLES + 5; i++) samples = appendActivity(samples, [], 50_000 + i * 10_000, true);
    expect(samples).toHaveLength(MAX_SAMPLES);
    expect(appendActivity([], [], 0, true)).toHaveLength(1);
  });
  it('exposes malformed cycles without duplicating or losing records', () => {
    const forest = sessionForest([session('a', { parentSessionId: 'b' }), session('b', { parentSessionId: 'a' })]);
    expect(forest.roots.map((s) => s.id)).toEqual(['a', 'b']);
    expect(forest.children.size).toBe(0);
  });
});
