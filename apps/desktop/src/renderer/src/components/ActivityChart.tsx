import { useEffect, useState } from 'react';
import type { DashboardHistoryCursor, DashboardHistoryPage, DashboardHistoryPoint, DashboardHistoryView } from '@spawnea/domain';
import type { ActivitySample } from './session-overview';

const label = (time: number) => new Date(time).toLocaleString();

/** A bounded set of observations covering the requested time range. */
export function ActivityChart({ samples, startedAt, bounds, onRangeChange }: { samples: (ActivitySample & Partial<DashboardHistoryPoint>)[]; startedAt: number; bounds?: [number, number]; onRangeChange?: (range: { from: number; to: number } | null) => void }) {
  const first = bounds?.[0] ?? samples[0]?.time ?? startedAt;
  const last = bounds?.[1] ?? samples.at(-1)?.time ?? first;
  const [range, setRange] = useState<[number, number] | null>(null);
  const [selected, setSelected] = useState<{ time: number; ordinal: number } | null>(null);
  const start = Math.max(first, Math.min(last, range?.[0] ?? first));
  const end = Math.max(start, Math.min(last, range?.[1] ?? last));
  const visible = samples.filter((sample) => sample.time >= start && sample.time <= end);
  const sameTime = selected === null ? [] : visible.flatMap((sample, i) => sample.time === selected.time ? [i] : []);
  const index = selected === null || visible.length === 0 ? 0 : sameTime[Math.min(selected.ordinal, sameTime.length - 1)] ?? visible.reduce((closest, sample, i) =>
    Math.abs(sample.time - selected.time) < Math.abs(visible[closest].time - selected.time) ? i : closest, 0);
  const selectedSample = visible[index];
  const selectIndex = (next: number) => {
    const sample = visible[next];
    if (sample) setSelected({ time: sample.time, ordinal: visible.slice(0, next).filter((s) => s.time === sample.time).length });
  };
  const max = Math.max(1, ...visible.filter((s) => !s.gap).flatMap((s) => [s.parents, s.children]));
  const path = (key: 'parents' | 'children') => {
    let drawing = false;
    return visible.map((s) => {
      if (s.gap || s.containsGap || s.summarized) { drawing = false; return ''; }
      const x = 35 + (s.time - start) / Math.max(1, end - start) * 430;
      const y = 140 - s[key] / max * 110;
      const result = `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      drawing = true;
      return result;
    }).join(' ');
  };
  const changeRange = (factor: number, shift = 0) => {
    const total = last - first;
    if (total <= 0) return;
    const width = Math.min(total, Math.max(1, (end - start) * factor));
    const center = (start + end) / 2 + (end - start) * shift;
    const nextStart = Math.max(first, Math.min(last - width, center - width / 2));
    const next: [number, number] = [Math.floor(nextStart), Math.ceil(nextStart + width)];
    setSelected(null);
    setRange(next);
    onRangeChange?.({ from: next[0], to: next[1] });
  };
  const selectAt = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!visible.length) return;
    const svg = event.currentTarget;
    if (typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') return;
    let x: number;
    try {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      x = point.matrixTransform(matrix.inverse()).x;
    } catch {
      return;
    }
    if (!Number.isFinite(x)) return;
    const fraction = Math.max(0, Math.min(1, (x - 35) / 430));
    const time = start + fraction * (end - start);
    let closest = 0;
    for (let i = 1; i < visible.length; i++) {
      if (Math.abs(visible[i].time - time) < Math.abs(visible[closest].time - time)) closest = i;
    }
    selectIndex(closest);
  };
  return (
    <section className="rounded-xl border border-zinc-800/80 bg-[#111620] p-4">
      <h2 className="text-sm font-semibold text-white">Observed activity</h2>
      <p className="text-[11px] text-zinc-400">Working or starting sessions · local time</p>
      <p className="text-[11px] text-zinc-400">Green: parents · Blue: children · Amber: interval contains a gap</p>
      <svg viewBox="0 0 500 170" role="img" aria-label="Observed concurrent working sessions" onPointerMove={selectAt} className="w-full max-h-48">
        <line x1="35" y1="140" x2="465" y2="140" stroke="#3f3f46" />
        <text x="10" y="34" fill="#71717a" fontSize="10">{max}</text>
        <text x="10" y="144" fill="#71717a" fontSize="10">0</text>
        <path d={path('parents')} stroke="#10b981" strokeWidth="2.5" fill="none" />
        <path d={path('children')} stroke="#38bdf8" strokeWidth="2" strokeDasharray="4 3" fill="none" />
        {visible.map((s, i) => (s.gap || s.containsGap) && <line key={`gap-${i}`} x1={35 + (s.time - start) / Math.max(1, end - start) * 430} x2={35 + (s.time - start) / Math.max(1, end - start) * 430} y1="20" y2="140" stroke="#f59e0b" strokeDasharray="3 3" />)}
        {visible.map((s, i) => !s.gap && <g key={`${s.time}-${i}`}>
          <circle cx={35 + (s.time - start) / Math.max(1, end - start) * 430} cy={140 - s.parents / max * 110} r="2" fill="#10b981" />
          <circle cx={35 + (s.time - start) / Math.max(1, end - start) * 430} cy={140 - s.children / max * 110} r="2" fill="#38bdf8" />
        </g>)}
        {selectedSample && <line x1={35 + (selectedSample.time - start) / Math.max(1, end - start) * 430} x2={35 + (selectedSample.time - start) / Math.max(1, end - start) * 430} y1="20" y2="140" stroke="#a1a1aa" strokeDasharray="3 3" />}
      </svg>
      <div className="flex justify-between gap-2 text-[11px] text-zinc-400"><span>{label(start)}</span><span>{label(end)}</span></div>
      <div className="flex flex-wrap gap-2 my-2 text-xs text-zinc-300">
        <button type="button" onClick={() => changeRange(1, -0.5)}>Pan left</button>
        <button type="button" onClick={() => changeRange(1, 0.5)}>Pan right</button>
        <button type="button" onClick={() => changeRange(0.5)}>Zoom in</button>
        <button type="button" onClick={() => changeRange(2)}>Zoom out</button>
        <button type="button" onClick={() => { setSelected(null); setRange(null); onRangeChange?.(null); }}>Full range</button>
      </div>
      {visible.length > 0 ? <>
        <input aria-label="Activity observation" className="w-full" type="range" min={0} max={visible.length - 1} value={index} onChange={(e) => selectIndex(Number(e.target.value))} />
        <p aria-live="polite" className="text-xs text-zinc-300">{label(selectedSample.time)} · {selectedSample.gap ? 'Unobserved period' : `Parents: ${selectedSample.parents} · Children: ${selectedSample.children}`}{selectedSample.containsGap && !selectedSample.gap ? ' · This interval contains an unobserved period' : ''}{selectedSample.summarized ? ' · Multiple observations in this interval; zoom in for detail' : ''}</p>
      </> : <p className="text-xs text-zinc-500">No observations in this range</p>}
    </section>
  );
}

export function HistoryChart({ revision }: { revision: number }) {
  const [view, setView] = useState<DashboardHistoryView | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [overviewError, setOverviewError] = useState('');
  const [pageError, setPageError] = useState('');
  const [pageLoading, setPageLoading] = useState(false);
  const [pageAttempt, setPageAttempt] = useState(0);
  const [browse, setBrowse] = useState<{ from: number; to: number } | null>(null);
  const [cursors, setCursors] = useState<(DashboardHistoryCursor | null)[]>([null]);
  const [page, setPage] = useState<DashboardHistoryPage | null>(null);
  useEffect(() => {
    let active = true;
    window.spawneaApi.getDashboardHistory(range ?? undefined).then((result) => {
      if (active) { setView(result); setOverviewError(''); }
    }, () => { if (active) setOverviewError('Could not load dashboard history.'); });
    return () => { active = false; };
  }, [range, revision]);
  useEffect(() => {
    if (!browse) return;
    let active = true;
    setPage(null);
    setPageError('');
    setPageLoading(true);
    window.spawneaApi.getDashboardHistoryPage(browse, cursors.at(-1) ?? null).then((result) => {
      if (active) { setPage(result); setPageLoading(false); }
    }, () => { if (active) { setPageError('Could not load dashboard observations.'); setPageLoading(false); } });
    return () => { active = false; };
  }, [browse, cursors, pageAttempt]);
  const changeRange = (next: { from: number; to: number } | null) => {
    setBrowse(null);
    setCursors([null]);
    setRange(next);
  };
  return <>
    {overviewError && <p role="alert" className="text-xs text-rose-400">{overviewError}</p>}
    <p className="text-xs text-zinc-400">Closed sessions since history was enabled: {view?.closedCount ?? '—'}</p>
    <ActivityChart samples={view?.points ?? []} startedAt={Date.now()} bounds={view?.first != null && view.last != null ? [view.first, view.last] : undefined} onRangeChange={changeRange} />
    {view?.first != null && view.last != null && <button className="text-xs text-zinc-300 mt-2" type="button" onClick={() => { setCursors([null]); setBrowse(range ?? { from: view.first!, to: view.last! }); }}>Browse observations in this range</button>}
    {browse && <div className="text-xs text-zinc-300 mt-2">
      <p>Observations {pageLoading ? '(loading)' : ''}</p>
      {pageError && <p role="alert" className="text-rose-400">{pageError} <button type="button" onClick={() => setPageAttempt((attempt) => attempt + 1)}>Retry observations</button></p>}
      {page && <ul aria-label="Observed activity records">{page.observations.map((s) => <li key={s.id}>{label(s.time)} · {s.gap ? 'Unobserved period' : `Parents: ${s.parents} · Children: ${s.children}`}</li>)}</ul>}
      <button type="button" disabled={cursors.length <= 1} onClick={() => setCursors((previous) => previous.slice(0, -1))}>Previous page</button>{' '}
      <button type="button" disabled={!page?.next} onClick={() => { if (page?.next) setCursors((previous) => [...previous, page.next!]); }}>Next page</button>
    </div>}
  </>;
}
