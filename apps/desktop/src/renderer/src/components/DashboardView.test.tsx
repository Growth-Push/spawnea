import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Session } from '@spawnea/domain';
import { DashboardView } from './DashboardView';
import { appendActivity, countWorking, MAX_SAMPLES, sessionForest } from './session-overview';

const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, name: id, task: `Task ${id}`, serverId: 'host', projectId: 'project', agentId: 'agent', branch: 'main', worktreePath: '/workspace/example', tmuxSessionName: id, status: 'working', createdAt: new Date(0), lastActivityAt: new Date(0), ...patch });
const props = { servers: [], projects: [], agents: [], activeSessionId: null, onSelectSession: vi.fn(), onReturn: vi.fn(), samples: [], startedAt: 0, isLoading: false };
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
});
describe('Aggregate observations', () => {
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
    expect(samples.every((s) => s.gap)).toBe(true);
    samples = appendActivity(samples, [], 40_000, true);
    expect(samples[2].gap).toBe(false);
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
