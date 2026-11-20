import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    const group = screen.getByRole('group', { name: 'Distribution group' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    fireEvent.click(within(group).getByRole('radio', { name: 'Host' }));
    const hostCategory = within(screen.getByRole('list', { name: 'Distribution legend' })).getByText('Unavailable host (remote):');
    expect(hostCategory.nextElementSibling?.textContent).toBe('1');
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
  it('distinguishes steps spanning summarized observations and breaks both series at gaps', () => {
    render(<ActivityChart startedAt={0} bounds={[0, 430]} samples={[
      { time: 0, parents: 0, children: 2, gap: false },
      { time: 50, parents: 0, children: 1, gap: false, summarized: true, containsGap: false },
      { time: 100, parents: 2, children: 0, gap: false },
      { time: 150, parents: 1, children: 1, gap: false, summarized: true, containsGap: true },
      { time: 200, parents: 1, children: 2, gap: false },
      { time: 201, parents: 2, children: 0, gap: false },
      { time: 250, parents: 0, children: 0, gap: true },
      { time: 300, parents: 0, children: 0, gap: false },
      { time: 350, parents: 1, children: 1, gap: false },
    ]} />);

    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    const [parents, children, summarizedParents, summarizedChildren] = chart.querySelectorAll('path');
    expect(parents.getAttribute('d')).toBe(
      'M35.0,140.0 H85.0 V140.0 M235.0,85.0 H236.0 V30.0 M335.0,140.0 H385.0 V85.0',
    );
    expect(children.getAttribute('d')).toBe(
      'M35.0,30.0 H85.0 V85.0 M235.0,30.0 H236.0 V140.0 M335.0,140.0 H385.0 V85.0',
    );
    expect(summarizedParents.getAttribute('d')).toBe('M85.0,140.0 H135.0 V30.0');
    expect(summarizedChildren.getAttribute('d')).toBe('M85.0,85.0 H135.0 V140.0');
    expect(summarizedParents.getAttribute('stroke')).toBe(parents.getAttribute('stroke'));
    expect(summarizedChildren.getAttribute('stroke')).toBe(children.getAttribute('stroke'));
    expect(summarizedParents.getAttribute('stroke-opacity')).toBe('0.6');
    expect(summarizedChildren.getAttribute('stroke-opacity')).toBe('0.6');
    expect(chart.querySelectorAll('[stroke-dasharray], [stroke="#f59e0b"]')).toHaveLength(0);
    expect(screen.getByText('Faded: summarized')).toBeTruthy();
    const slider = screen.getByRole('slider', { name: 'Activity observation' });
    expect(slider.getAttribute('aria-valuetext')).toContain('Parents: 0 · Children: 2');
    fireEvent.change(slider, { target: { value: '3' } });
    expect(slider.getAttribute('aria-valuetext')).toContain('This interval contains an unobserved period');
    expect(slider.getAttribute('aria-valuetext')).toContain('Multiple observations');
    fireEvent.change(slider, { target: { value: '6' } });
    expect(slider.getAttribute('aria-valuetext')).toContain('Unobserved period');
    expect(slider.getAttribute('aria-valuetext')).not.toContain('Parents:');
  });

  it('labels a sparse range without a count scale and recovers the observed zero by panning', () => {
    const base = 1_760_000_000_000;
    const rows = [[0, 1, 1], [1000, 1, 1], [2000, 0, 1], [350_000, 0, 0],
      [352_000, 0, 0], [355_000, 0, 0], [360_000, 0, 0], [398_999, 1, 1]];
    const samples = rows.map(([offset, parents, children]) => ({ time: base + offset, parents, children, gap: false }));
    const onRangeChange = vi.fn();
    render(<ActivityChart samples={samples} startedAt={base} bounds={[base, base + 399_000]} onRangeChange={onRangeChange} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    const ticks = () => [...chart.querySelectorAll('text')].map((tick) => tick.textContent);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onRangeChange).toHaveBeenLastCalledWith({ from: base + 99_750, to: base + 299_250 });
    expect(screen.getByText('No observations in this range')).toBeTruthy();
    const timeline = screen.getByRole('group', { name: 'Activity timeline' });
    expect(timeline.getAttribute('aria-describedby')).toBeTruthy();
    const description = document.getElementById(timeline.getAttribute('aria-describedby')!);
    expect(description?.textContent).toContain(new Date(base + 99_750).toLocaleString());
    expect(description?.textContent).toContain(new Date(base + 299_250).toLocaleString());
    expect(ticks()).not.toContain('0');
    expect(chart.querySelectorAll('circle')).toHaveLength(0);
    expect(screen.queryByRole('slider')).toBeNull();

    fireEvent.keyDown(screen.getByRole('group', { name: 'Activity timeline' }), { key: 'ArrowRight' });
    expect(screen.queryByText('No observations in this range')).toBeNull();
    expect(ticks()).toContain('0');
    expect(chart.querySelector('path[stroke="#10b981"]')?.getAttribute('d')).toContain('140.0');
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('Parents: 0 · Children: 0');

    fireEvent.click(screen.getByRole('button', { name: 'Full range' }));
    expect(onRangeChange).toHaveBeenLastCalledWith(null);
    expect(chart.querySelectorAll('circle')).toHaveLength(0);
  });

  it('distinguishes matching clock labels on different local days in a range shorter than 24 hours', () => {
    // Build the same clock times as the sparse fixture in the test runner's local zone.
    const start = new Date(2025, 9, 9, 10, 0, 50).getTime();
    const end = start + 86_361_000;
    render(<ActivityChart startedAt={start} bounds={[start, end]} samples={[
      { time: start, parents: 1, children: 1, gap: false },
      { time: start + 43_200_000, parents: 0, children: 1, gap: false },
      { time: end - 1000, parents: 1, children: 0, gap: false },
    ]} />);

    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    const ticks = [...chart.querySelectorAll('text')].map((tick) => tick.textContent);
    const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(ticks[2]).toBe(format.format(new Date(2025, 9, 9, 12)));
    expect(ticks.at(-1)).toBe(format.format(new Date(2025, 9, 10)));
    expect(ticks.at(-1)).not.toBe(ticks[2]);
  });

  it.each([20_000, 120_000])('aligns dated ticks to a uniform clock step across midnight (%i ms)', (duration) => {
    const start = new Date(2025, 11, 31, 23, 59, 46).getTime();
    const end = start + duration;
    render(<ActivityChart startedAt={start} bounds={[start, end]} samples={[
      { time: start, parents: 1, children: 1, gap: false },
      { time: end - 1, parents: 1, children: 0, gap: false },
    ]} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    const labels = [...chart.querySelectorAll('text')].slice(2);
    const format = new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      ...(duration === 20_000 ? { second: '2-digit' } : {}),
    });
    const midnight = new Date(2026, 0, 1);
    const clockStep = duration === 20_000 ? 10_000 : 60_000;
    expect(labels.map((tick) => tick.textContent)).toEqual(
      [-clockStep, 0].concat(duration === 120_000 ? [clockStep] : [])
        .filter((delta) => midnight.getTime() + delta >= start)
        .map((delta) => format.format(midnight.getTime() + delta)),
    );
    const positions = labels.map((tick) => Number(tick.getAttribute('x')));
    expect(positions[1] - positions[0]).toBeCloseTo(430 * clockStep / duration);
    const descriptionId = screen.getByRole('group', { name: 'Activity timeline' }).getAttribute('aria-describedby')!;
    expect(document.getElementById(descriptionId)?.classList.contains('sr-only')).toBe(duration === 20_000);
  });

  it('pans a zoomed range by dragging the plot without changing the observation slider', () => {
    const samples = [0, 10_000, 20_000, 30_000, 40_000].map((time) => ({ time, parents: 1, children: 0, gap: false }));
    const onRangeChange = vi.fn();
    render(<ActivityChart samples={samples} startedAt={0} onRangeChange={onRangeChange} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    const setPointerCapture = vi.fn();
    Object.defineProperty(chart, 'setPointerCapture', { value: setPointerCapture });
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ width: 477 } as DOMRect);

    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      fireEvent(chart, event);
    };
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onRangeChange).toHaveBeenLastCalledWith({ from: 10_000, to: 30_000 });
    pointer('pointerdown', 250);
    pointer('pointermove', 164);
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    pointer('pointerup', 164);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(onRangeChange).toHaveBeenLastCalledWith({ from: 14_000, to: 34_000 });
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('0');
  });

  it('draws exact steps without run markers and leaves an isolated zero inspectable', () => {
    const samples = [
      { time: 0, parents: 1, children: 0, gap: false },
      { time: 1000, parents: 1, children: 0, gap: false },
      { time: 2000, parents: 1, children: 2, gap: false },
      { time: 3000, parents: 0, children: 0, gap: true },
      { time: 4000, parents: 0, children: 0, gap: false },
    ];
    render(<ActivityChart samples={samples} startedAt={0} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    const markers = [...chart.querySelectorAll('circle')];
    expect(markers).toHaveLength(2);
    expect(markers.every((marker) => marker.getAttribute('cy') === '140')).toBe(true);
    setScreenTransform(chart, 1, 0, 0);
    movePointer(chart, 465);
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('Parents: 0 · Children: 0');
  });

  it('renders an explicit count-free state for empty samples and summarized gap-only history', () => {
    const view = render(<ActivityChart samples={[]} startedAt={1000} bounds={[1000, 11_000]} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    const ticks = () => [...chart.querySelectorAll('text')].map((tick) => tick.textContent);
    expect(screen.getByText('No observations in this range')).toBeTruthy();
    expect(ticks().length).toBeGreaterThanOrEqual(2);
    expect(ticks()).not.toContain('0');
    expect(screen.queryByRole('slider')).toBeNull();

    view.rerender(<ActivityChart startedAt={1000} samples={[
      { time: 1000, parents: 0, children: 0, gap: true, summarized: true, containsGap: true },
    ]} bounds={[1000, 11_000]} />);
    expect(screen.getByText('Unobserved period in this range')).toBeTruthy();
    expect(ticks().length).toBeGreaterThanOrEqual(2);
    expect(ticks()).not.toContain('0');
    expect(chart.querySelectorAll('circle')).toHaveLength(0);
    expect(screen.queryByText('Faded: summarized')).toBeNull();
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('Unobserved period');
  });

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
    fireEvent.click(await screen.findByRole('button', { name: /History · 2 closed/ }));
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
    expect(await screen.findByRole('button', { name: /History · 2 closed/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await vi.waitFor(() => expect(getDashboardHistory).toHaveBeenLastCalledWith({ from: 3500, to: 8500 }));
    fireEvent.click(screen.getByRole('button', { name: 'Full range' }));
    await vi.waitFor(() => expect(getDashboardHistory).toHaveBeenLastCalledWith(undefined));
    fireEvent.click(screen.getByRole('button', { name: /History · 2 closed/ }));
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
    fireEvent.keyDown(screen.getByRole('group', { name: 'Activity timeline' }), { key: 'ArrowRight' });
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
  it('uses the resized plot width for time coordinates and pointer inspection', () => {
    let resize: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    try {
      const view = render(<ActivityChart startedAt={0} samples={[
        { time: 0, parents: 0, children: 1, gap: false },
        { time: 10_000, parents: 2, children: 0, gap: false },
      ]} />);
      const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
      act(() => resize?.([{ contentRect: { width: 800 } } as ResizeObserverEntry], {} as ResizeObserver));
      expect(chart.getAttribute('viewBox')).toBe('0 0 800 170');
      expect(chart.querySelector('path')?.getAttribute('d')).toBe('M35.0,140.0 H788.0 V30.0');
      setScreenTransform(chart, 1, 0, 0);
      movePointer(chart, 788);
      expect(screen.getByText(/Parents: 2 · Children: 0/)).toBeTruthy();
      view.unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('ignores a pointer when its SVG transform is unavailable or non-invertible', () => {
    render(<ActivityChart samples={[{ time: 0, parents: 1, children: 0, gap: false }, { time: 10_000, parents: 2, children: 0, gap: false }]} startedAt={0} />);
    const chart = screen.getByRole('img', { name: 'Observed concurrent working sessions' });
    Object.defineProperty(chart, 'getScreenCTM', { configurable: true, value: () => null });
    movePointer(chart, 465);
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('Parents: 1 · Children: 0');
    setScreenTransform(chart, 1, 0, 0);
    Object.defineProperty(chart, 'getScreenCTM', { configurable: true, value: () => ({ inverse: () => { throw new Error('non-invertible'); } }) });
    movePointer(chart, 465);
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('Parents: 1 · Children: 0');
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
