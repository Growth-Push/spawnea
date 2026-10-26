import React, { useState } from 'react';
import type { Agent, Project, Server, Session } from '@spawnea/domain';
import {
  ArrowLeft,
  Plus,
  Layers,
  Play,
  Pause,
  AlertTriangle,
  CircleDot,
  Server as ServerIcon,
  Folder,
  Terminal,
  Search,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { needsAttention, sessionForest, type ActivitySample } from './session-overview';

interface Props {
  sessions: Session[];
  servers: Server[];
  projects: Project[];
  agents: Agent[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onReturn: () => void;
  onOpenCreateModal?: () => void;
  samples: ActivitySample[];
  startedAt: number;
  isLoading: boolean;
}

const colors = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
const timeLabel = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function formatRelativeTime(dateInput: Date | string | number): string {
  const date = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
  const now = Date.now();
  const diffSec = Math.floor((now - date.getTime()) / 1000);
  if (isNaN(diffSec) || diffSec < 10) return 'now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function StatusPill({ status }: { status: Session['status'] }) {
  switch (status) {
    case 'working':
    case 'starting':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Working
        </span>
      );
    case 'needs_input':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          Needs input
        </span>
      );
    case 'error':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
          Error
        </span>
      );
    case 'idle':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700/50">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
          Idle
        </span>
      );
    case 'done':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700/50">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />
          Done
        </span>
      );
    case 'disconnected':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-500 border border-zinc-700/50">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
          Disconnected
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800 text-zinc-400">
          {status}
        </span>
      );
  }
}

export function ActivityChart({ samples, startedAt }: Pick<Props, 'samples' | 'startedAt'>) {
  const validSamples = samples.filter((s) => !s.gap);
  const max = Math.max(1, ...validSamples.map((s) => Math.max(s.parents, s.children)));
  const start = samples[0]?.time ?? startedAt;
  const end = samples.at(-1)?.time ?? start;
  const latest = samples.at(-1);

  // Build segmented SVG lines breaking across gaps
  const buildPath = (key: 'parents' | 'children') => {
    let penDown = false;
    return samples
      .map((s) => {
        if (s.gap) {
          penDown = false;
          return '';
        }
        const x = 35 + ((s.time - start) / Math.max(1, end - start)) * 430;
        const y = 140 - (s[key] / max) * 110;
        const cmd = penDown ? 'L' : 'M';
        penDown = true;
        return `${cmd}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');
  };

  const linePath = buildPath('parents');
  const childrenLinePath = buildPath('children');

  // Build area segments only for contiguous non-gap samples
  const areaSegments: string[] = [];
  let currentSegment: { x: number; y: number }[] = [];
  for (const s of samples) {
    if (s.gap) {
      if (currentSegment.length > 0) {
        const segLine = currentSegment.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        const segArea = `${segLine} L${currentSegment[currentSegment.length - 1].x.toFixed(1)},140 L${currentSegment[0].x.toFixed(1)},140 Z`;
        areaSegments.push(segArea);
        currentSegment = [];
      }
    } else {
      const x = 35 + ((s.time - start) / Math.max(1, end - start)) * 430;
      const y = 140 - (s.parents / max) * 110;
      currentSegment.push({ x, y });
    }
  }
  if (currentSegment.length > 0) {
    const segLine = currentSegment.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const segArea = `${segLine} L${currentSegment[currentSegment.length - 1].x.toFixed(1)},140 L${currentSegment[0].x.toFixed(1)},140 Z`;
    areaSegments.push(segArea);
  }

  const lastSample = [...samples].reverse().find((s) => !s.gap);
  const lastPoint = lastSample
    ? {
        x: 35 + ((lastSample.time - start) / Math.max(1, end - start)) * 430,
        y: 140 - (lastSample.parents / max) * 110,
      }
    : null;

  return (
    <section className="rounded-xl border border-zinc-800/80 bg-[#111620] p-4 flex flex-col justify-between">
      <div className="flex items-center justify-between pb-2 border-b border-zinc-850/60">
        <div>
          <h2 className="text-sm font-semibold text-white">Observed activity</h2>
          <p className="text-[11px] text-zinc-400">
            Working sessions · local time · started {timeLabel(startedAt)}
          </p>
        </div>
      </div>

      <div className="py-2">
        <svg
          viewBox="0 0 500 170"
          role="img"
          aria-label={`Concurrent working sessions. Parents: ${latest && !latest.gap ? latest.parents : 'unavailable'}. Children: ${latest && !latest.gap ? latest.children : 'unavailable'}.`}
          className="w-full max-h-48"
        >
          <defs>
            <linearGradient id="activityAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line x1="35" y1="30" x2="480" y2="30" stroke="#27272a" strokeDasharray="3 3" />
          <line x1="35" y1="85" x2="480" y2="85" stroke="#27272a" strokeDasharray="3 3" />
          <line x1="35" y1="140" x2="480" y2="140" stroke="#3f3f46" />

          {/* Y-axis values */}
          <text x="10" y="34" fill="#71717a" fontSize="10">{max}</text>
          <text x="10" y="89" fill="#71717a" fontSize="10">{(max / 2).toFixed(max % 2 === 0 ? 0 : 1)}</text>
          <text x="10" y="144" fill="#71717a" fontSize="10">0</text>

          {/* Segmented Area fills */}
          {areaSegments.map((d, idx) => (
            <path key={idx} d={d} fill="url(#activityAreaGrad)" />
          ))}

          {/* Parents line */}
          {linePath && <path d={linePath} stroke="#10b981" strokeWidth="2.5" fill="none" />}

          {/* Children line */}
          {childrenLinePath && (
            <path d={childrenLinePath} stroke="#38bdf8" strokeWidth="2" strokeDasharray="4 3" fill="none" />
          )}

          {/* Now vertical line marker */}
          {lastPoint && (
            <g>
              <line
                x1={lastPoint.x}
                y1="18"
                x2={lastPoint.x}
                y2="140"
                stroke="#10b981"
                strokeDasharray="3 3"
                strokeWidth="1.5"
              />
              <circle cx={lastPoint.x} cy={lastPoint.y} r="3.5" fill="#10b981" />
              <text x={lastPoint.x} y="14" fill="#10b981" fontSize="9" fontWeight="bold" textAnchor="middle">
                Now
              </text>
            </g>
          )}

          {/* X-axis labels */}
          <text x="35" y="160" fill="#71717a" fontSize="10">{timeLabel(start)}</text>
          <text x="480" y="160" textAnchor="end" fill="#71717a" fontSize="10">{timeLabel(end)}</text>
        </svg>
      </div>

      <div className="flex items-center justify-between text-xs pt-1 border-t border-zinc-850/60">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-emerald-400">
            <span className="w-2.5 h-0.5 bg-emerald-400" />
            Parents: {latest && !latest.gap ? latest.parents : '—'}
          </span>
          <span className="flex items-center gap-1.5 text-sky-400">
            <span className="w-2.5 h-0.5 bg-sky-400 border-b border-dashed border-sky-400" />
            Children: {latest && !latest.gap ? latest.children : '—'}
          </span>
        </div>
        {!validSamples.length && <p className="text-zinc-500 text-xs">Waiting for observations</p>}
      </div>

      {samples.length > 0 && (
        <details className="mt-2 text-xs text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-400">Detailed activity log</summary>
          <table className="mt-1 w-full text-left" aria-label="Observed session activity history">
            <thead>
              <tr className="border-b border-zinc-800 text-[11px] text-zinc-400">
                <th className="pr-2 py-1">Time</th>
                <th className="pr-2 py-1">Parents</th>
                <th className="pr-2 py-1">Children</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s, i) => (
                <tr key={`${s.time}-${i}`} className="border-b border-zinc-850/40">
                  <td className="pr-2 py-1">{timeLabel(s.time)}</td>
                  <td className="pr-2 py-1">{s.gap ? '—' : s.parents}</td>
                  <td className="pr-2 py-1">{s.gap ? '—' : s.children}</td>
                  <td className="py-1">{s.gap ? 'Unobserved period (gap)' : 'Observed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

export function DashboardView(props: Props) {
  const {
    sessions,
    servers,
    projects,
    agents,
    onReturn,
    onSelectSession,
    onOpenCreateModal,
    activeSessionId,
    isLoading,
    samples,
    startedAt,
  } = props;

  const [attention, setAttention] = useState(false);
  const [search, setSearch] = useState('');
  const [dimension, setDimension] = useState<'Harness' | 'Project' | 'Host'>('Harness');
  const [collapsedHosts, setCollapsedHosts] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const toggleHost = (hostId: string) => {
    setCollapsedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  };

  const toggleProject = (projectKey: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  };

  const forest = sessionForest(sessions);
  const all = [...forest.byId.values()];
  const hostName = (id: string) => servers.find((s) => s.id === id)?.name ?? `Unavailable host (${id})`;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? `Unavailable project (${id})`;
  const harness = (id: string) => agents.find((a) => a.id === id)?.harness ?? `Unavailable harness (${id})`;

  // KPI counts
  const workingSessions = all.filter((s) => s.status === 'working' || s.status === 'starting').length;
  const needInputSessions = all.filter((s) => s.status === 'needs_input').length;
  const errorSessions = all.filter((s) => s.status === 'error').length;
  const idleSessions = all.filter((s) => s.status === 'idle' || s.status === 'done').length;
  const hostsCount = new Set(all.map((s) => s.serverId)).size;
  const projectsCount = new Set(all.map((s) => s.projectId)).size;

  const matches = (s: Session) =>
    (!attention || needsAttention(s)) &&
    [s.name, s.task, s.branch, hostName(s.serverId), projectName(s.projectId), harness(s.agentId)].some((v) =>
      v.toLowerCase().includes(search.toLowerCase())
    );

  const visible = (s: Session): boolean => matches(s) || (forest.children.get(s.id) ?? []).some(visible);

  const groups = new Map<string, Map<string, Session[]>>();
  for (const root of forest.roots.filter(visible)) {
    const host = groups.get(root.serverId) ?? new Map<string, Session[]>();
    host.set(root.projectId, [...(host.get(root.projectId) ?? []), root]);
    groups.set(root.serverId, host);
  }

  // Distribution calculation
  const distribution = new Map<string, { label: string; count: number }>();
  for (const s of all) {
    const key = dimension === 'Host' ? s.serverId : dimension === 'Project' ? s.projectId : harness(s.agentId);
    const label = dimension === 'Host' ? hostName(s.serverId) : dimension === 'Project' ? projectName(s.projectId) : key;
    const entry = distribution.get(key) ?? { label, count: 0 };
    entry.count += 1;
    distribution.set(key, entry);
  }

  // Donut chart stroke segments
  const totalDistributionCount = all.length;
  const donutRadius = 60;
  const donutCircumference = 2 * Math.PI * donutRadius;
  let accumulatedPercent = 0;

  return (
    <section aria-label="Session dashboard" className="flex-1 min-w-0 overflow-auto p-6 space-y-5 bg-[#0d1117]">
      {/* Top Header */}
      <header className="flex items-center justify-between pb-1">
        <div className="flex items-center gap-3">
          <button
            autoFocus
            type="button"
            onClick={onReturn}
            aria-label="Return to workspace"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161b22] hover:bg-[#21262d] text-zinc-300 hover:text-white border border-zinc-700/60 text-xs font-medium transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to workspace</span>
          </button>
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-xl font-bold text-white tracking-tight">Dashboard</h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live data
            </span>
            <span className="text-xs text-zinc-400">All current sessions: {all.length}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onOpenCreateModal && (
            <button
              type="button"
              onClick={onOpenCreateModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold shadow-sm transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New session</span>
            </button>
          )}
        </div>
      </header>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Card 1: Total */}
        <div className="rounded-xl border border-zinc-800/80 bg-[#111620] p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold text-white">{all.length}</span>
            <Layers className="w-4 h-4 text-zinc-500" />
          </div>
          <span className="text-xs text-zinc-400 font-medium mt-1">Sessions</span>
        </div>

        {/* Card 2: Working */}
        <div className="rounded-xl border border-zinc-800/80 bg-[#111620] p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
              <span className="text-2xl font-bold text-white">{workingSessions}</span>
            </div>
            <Play className="w-4 h-4 text-emerald-400/70" />
          </div>
          <span className="text-xs text-zinc-400 font-medium mt-1">Working</span>
        </div>

        {/* Card 3: Need input */}
        <div className="rounded-xl border border-zinc-800/80 bg-[#111620] p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              <span className="text-2xl font-bold text-white">{needInputSessions}</span>
            </div>
            <Pause className="w-4 h-4 text-amber-400/70" />
          </div>
          <span className="text-xs text-zinc-400 font-medium mt-1">Need input</span>
        </div>

        {/* Card 4: Error */}
        <div className="rounded-xl border border-zinc-800/80 bg-[#111620] p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
              <span className="text-2xl font-bold text-white">{errorSessions}</span>
            </div>
            <AlertTriangle className="w-4 h-4 text-rose-500/70" />
          </div>
          <span className="text-xs text-zinc-400 font-medium mt-1">Error</span>
        </div>

        {/* Card 5: Idle */}
        <div className="rounded-xl border border-zinc-800/80 bg-[#111620] p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-zinc-400" />
              <span className="text-2xl font-bold text-white">{idleSessions}</span>
            </div>
            <CircleDot className="w-4 h-4 text-zinc-400/70" />
          </div>
          <span className="text-xs text-zinc-400 font-medium mt-1">Idle</span>
        </div>

        {/* Card 6: Infrastructure */}
        <div className="rounded-xl border border-zinc-800/80 bg-[#111620] p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
              <span>{hostsCount} hosts</span>
              <span className="text-zinc-600">·</span>
              <span>{projectsCount} projects</span>
            </div>
            <ServerIcon className="w-4 h-4 text-zinc-500" />
          </div>
          <span className="text-xs text-zinc-400 font-medium mt-1">Infrastructure</span>
        </div>
      </div>

      {/* Middle Row: Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Activity Chart */}
        <ActivityChart samples={samples} startedAt={startedAt} />

        {/* Distribution Chart */}
        <section className="rounded-xl border border-zinc-800/80 bg-[#111620] p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between pb-2 border-b border-zinc-850/60">
            <div>
              <h2 className="text-sm font-semibold text-white">Session distribution</h2>
              <p className="text-[11px] text-zinc-400">Current sessions by {dimension.toLowerCase()}</p>
            </div>
            <div className="flex items-center gap-1 bg-zinc-850 p-1 rounded-lg border border-zinc-800">
              {(['Harness', 'Project', 'Host'] as const).map((dim) => (
                <button
                  key={dim}
                  type="button"
                  onClick={() => setDimension(dim)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    dimension === dim
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {dim}
                </button>
              ))}
              <select
                aria-label="Distribution group"
                value={dimension}
                onChange={(e) => setDimension(e.target.value as 'Harness' | 'Project' | 'Host')}
                className="sr-only"
              >
                <option value="Harness">Harness</option>
                <option value="Project">Project</option>
                <option value="Host">Host</option>
              </select>
            </div>
          </div>

          <div className="py-2 flex items-center justify-around gap-6">
            {/* SVG Donut */}
            <div className="relative w-44 h-44 shrink-0 flex items-center justify-center">
              <svg viewBox="0 0 160 160" className="w-full h-full -rotate-90">
                {/* Background track circle */}
                <circle
                  cx="80"
                  cy="80"
                  r={donutRadius}
                  stroke="#1c2333"
                  strokeWidth="18"
                  fill="none"
                />
                {totalDistributionCount > 0 &&
                  [...distribution.entries()].map(([key, entry], i) => {
                    const percent = entry.count / totalDistributionCount;
                    const strokeDasharray = `${(percent * donutCircumference).toFixed(1)} ${donutCircumference.toFixed(1)}`;
                    const strokeDashoffset = (-accumulatedPercent * donutCircumference).toFixed(1);
                    accumulatedPercent += percent;
                    const color = colors[i % colors.length];

                    return (
                      <circle
                        key={key}
                        cx="80"
                        cy="80"
                        r={donutRadius}
                        stroke={color}
                        strokeWidth="18"
                        strokeDasharray={strokeDasharray}
                        strokeDashoffset={strokeDashoffset}
                        fill="none"
                      />
                    );
                  })}
              </svg>
              {/* Inner Center Text */}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-2xl font-bold text-white leading-none">{totalDistributionCount}</span>
                <span className="text-[11px] text-zinc-400 mt-0.5">sessions</span>
              </div>
            </div>

            {/* Legend */}
            <div className="flex-1 min-w-[140px] max-w-xs">
              {!all.length ? (
                <p className="text-zinc-500 text-xs">No sessions to distribute</p>
              ) : (
                <ul className="space-y-1.5 pl-2">
                  {[...distribution.entries()].map(([key, entry], i) => {
                    const color = colors[i % colors.length];
                    return (
                      <li key={key} className="text-xs list-disc font-medium" style={{ color }}>
                        {entry.label}: {entry.count}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="text-[11px] text-zinc-500 pt-1 border-t border-zinc-850/60">
            Total observed: {totalDistributionCount} sessions
          </div>
        </section>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-lg bg-[#111620] p-1 border border-zinc-800">
            <button
              type="button"
              onClick={() => setAttention(false)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                !attention
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              All sessions
            </button>
            <label className="cursor-pointer">
              <input
                type="checkbox"
                checked={attention}
                onChange={(e) => setAttention(e.target.checked)}
                className="sr-only"
              />
              <span
                className={`inline-block px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  attention
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Needs attention
              </span>
            </label>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions..."
              aria-label="Search sessions"
              className="w-64 pl-8 pr-3 py-1 rounded-lg bg-[#111620] border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/50"
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-zinc-500 font-medium">
          <span>Host</span>
          <span className="text-zinc-700">→</span>
          <span>Project</span>
          <span className="text-zinc-700">→</span>
          <span>Session</span>
        </div>
      </div>

      {/* Structured Sessions Table */}
      <div className="rounded-xl border border-zinc-800/80 bg-[#111620] overflow-hidden">
        {/* Table Column Headers */}
        <div className="grid grid-cols-[1fr_120px_100px_170px_110px_48px] items-center px-4 py-2.5 bg-[#161b22]/70 border-b border-zinc-800 text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
          <div>SESSION / TASK</div>
          <div className="text-center">STATUS</div>
          <div>HARNESS</div>
          <div>BRANCH</div>
          <div className="text-right pr-2">LAST ACTIVITY</div>
          <div className="text-center"></div>
        </div>

        {isLoading && (
          <div className="px-4 py-8 text-center text-zinc-400 text-xs" role="status">
            Loading sessions…
          </div>
        )}

        {!groups.size && !isLoading && (
          <div className="px-4 py-8 text-center text-zinc-400 text-xs">
            No matching sessions
          </div>
        )}

        {/* Tree Rows */}
        {[...groups.entries()].map(([hostId, hostProjects]) => {
          const isHostCollapsed = collapsedHosts.has(hostId);
          const countDescendants = (sessionId: string): number => {
            const kids = (forest.children.get(sessionId) ?? []).filter(visible);
            return kids.reduce((sum, kid) => sum + 1 + countDescendants(kid.id), 0);
          };
          const hostSessionsCount = [...hostProjects.values()].reduce(
            (acc, roots) =>
              acc +
              roots.reduce(
                (sum, root) => sum + (visible(root) ? 1 : 0) + countDescendants(root.id),
                0
              ),
            0
          );

          return (
            <div key={hostId} className="border-b border-zinc-800/60 last:border-b-0">
              {/* Host Group Header */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!isHostCollapsed}
                onClick={() => toggleHost(hostId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleHost(hostId);
                  }
                }}
                className="flex items-center justify-between px-4 py-2 bg-[#131922] hover:bg-[#161d27] border-b border-zinc-800/70 text-xs cursor-pointer select-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
              >
                <div className="flex items-center gap-2">
                  <span className="text-zinc-400">
                    {isHostCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </span>
                  <ServerIcon className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="font-semibold text-zinc-200">{hostName(hostId)}</span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-400 text-[11px]">
                    {hostProjects.size} projects · {hostSessionsCount} sessions
                  </span>
                </div>
              </div>

              {/* Projects under Host */}
              {!isHostCollapsed &&
                [...hostProjects.entries()].map(([projectId, roots]) => {
                  const projectKey = `${hostId}-${projectId}`;
                  const isProjectCollapsed = collapsedProjects.has(projectKey);

                  const renderSessionTree = (s: Session, depth = 0): React.ReactNode => {
                    const directChildren = (forest.children.get(s.id) ?? []).filter(visible);
                    const isChild = depth > 0;
                    const parentSession = s.parentSessionId ? forest.byId.get(s.parentSessionId) : undefined;
                    const isCrossAttributed =
                      isChild &&
                      parentSession &&
                      (s.serverId !== parentSession.serverId || s.projectId !== parentSession.projectId);

                    return (
                      <React.Fragment key={s.id}>
                        <div
                          className={`grid grid-cols-[1fr_120px_100px_170px_110px_48px] items-center px-4 py-2 border-b border-zinc-850/30 hover:bg-[#161f2e]/60 transition-colors ${
                            s.id === activeSessionId ? 'bg-emerald-500/5' : isChild ? 'bg-[#0b0f15]/50' : ''
                          }`}
                        >
                          {/* Column 1: Session / Task */}
                          <div
                            className="flex items-start min-w-0"
                            style={{ paddingLeft: `${Math.max(2.5, 2.5 + depth * 1.5)}rem` }}
                          >
                            {isChild ? (
                              <span className="text-zinc-600 mr-2 font-mono select-none text-xs leading-5">
                                └─
                              </span>
                            ) : (
                              <Terminal className="w-3.5 h-3.5 text-zinc-500 mr-2 mt-0.5 shrink-0" />
                            )}
                            <div className="min-w-0 pr-2">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  aria-current={s.id === activeSessionId ? 'true' : undefined}
                                  onClick={() => onSelectSession(s.id)}
                                  className="font-medium text-zinc-200 hover:text-emerald-400 transition-colors truncate text-left text-xs"
                                  title={s.name}
                                >
                                  {s.name}
                                </button>
                                {directChildren.length > 0 && !isChild && (
                                  <span className="text-[11px] text-zinc-500 shrink-0">
                                    · {directChildren.length} {directChildren.length === 1 ? 'child' : 'children'}
                                  </span>
                                )}
                                {isCrossAttributed && (
                                  <span
                                    className="text-[10px] text-zinc-400 bg-zinc-800/80 px-1.5 py-0.5 rounded border border-zinc-700/60 shrink-0 font-normal"
                                    title={`Assigned to ${hostName(s.serverId)} · ${projectName(s.projectId)}`}
                                  >
                                    {hostName(s.serverId)} / {projectName(s.projectId)}
                                  </span>
                                )}
                              </div>
                              {s.task && (
                                <p className="text-[11px] text-zinc-500 truncate mt-0.5" title={s.task}>
                                  {s.task}
                                </p>
                              )}
                              {s.parentSessionId && !forest.byId.has(s.parentSessionId) && (
                                <span className="text-[11px] text-amber-400 font-medium">
                                  Missing parent
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Column 2: Status */}
                          <div className="flex justify-center">
                            <StatusPill status={s.status} />
                          </div>

                          {/* Column 3: Harness */}
                          <div className="text-xs text-zinc-300 truncate font-medium">
                            {harness(s.agentId)}
                          </div>

                          {/* Column 4: Branch */}
                          <div className="text-xs font-mono text-zinc-400 truncate pr-2" title={s.branch}>
                            {s.branch}
                          </div>

                          {/* Column 5: Last Activity */}
                          <div className="text-xs text-zinc-400 text-right pr-2">
                            <time title={new Date(s.lastActivityAt).toLocaleString()}>
                              {formatRelativeTime(s.lastActivityAt)}
                            </time>
                          </div>

                          {/* Column 6: Action */}
                          <div className="flex justify-center">
                            <button
                              type="button"
                              onClick={() => onSelectSession(s.id)}
                              title={`Open ${s.name} terminal`}
                              className="p-1 rounded text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800 transition-colors"
                            >
                              <Terminal className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        {directChildren.map((child) => renderSessionTree(child, depth + 1))}
                      </React.Fragment>
                    );
                  };

                  return (
                    <div key={projectId} className="border-b border-zinc-850/40 last:border-b-0">
                      {/* Project Group Header */}
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={!isProjectCollapsed}
                        onClick={() => toggleProject(projectKey)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleProject(projectKey);
                          }
                        }}
                        className="flex items-center gap-2 px-4 py-1.5 pl-8 bg-[#0e131b] hover:bg-[#121822] border-b border-zinc-850/60 text-xs cursor-pointer select-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
                      >
                        <span className="text-zinc-500">
                          {isProjectCollapsed ? (
                            <ChevronRight className="w-3 h-3" />
                          ) : (
                            <ChevronDown className="w-3 h-3" />
                          )}
                        </span>
                        <Folder className="w-3.5 h-3.5 text-zinc-400" />
                        <span className="font-medium text-zinc-300">{projectName(projectId)}</span>
                        <span className="text-zinc-500 text-[11px]">· {roots.length} root sessions</span>
                      </div>

                      {/* Sessions under Project */}
                      {!isProjectCollapsed && (
                        <div>
                          {roots.map((root) => renderSessionTree(root))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}

        {/* Table Footer */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#131922] border-t border-zinc-800 text-[11px] text-zinc-400">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>Live session updates</span>
          </div>
          <div>{samples.length > 0 ? `Observed through ${timeLabel(samples.at(-1)!.time)}` : 'Updated now'}</div>
        </div>
      </div>
    </section>
  );
}
