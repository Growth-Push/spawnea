import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Maximize, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react';
import type { DashboardHistoryCursor, DashboardHistoryPage, DashboardHistoryPoint, DashboardHistoryView } from '@spawnea/domain';
import type { ActivitySample } from './session-overview';

const label = (time: number) => new Date(time).toLocaleString();
const card = 'min-w-0 rounded-xl border border-zinc-800/80 bg-[#111620] p-3';
const control = 'rounded border border-zinc-700/80 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-sky-400 disabled:opacity-40';
const plotLeft = 35;
const plotTop = 30;
const plotBottom = 140;
const plotHeight = 170;
const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;
const clockSteps = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  ...[1, 2, 5, 10, 15, 30].map((n) => n * second),
  ...[1, 2, 5, 10, 15, 30].map((n) => n * minute),
  ...[1, 2, 3, 4, 6, 12].map((n) => n * hour),
  day, 2 * day, 7 * day, 14 * day,
];

function RangeButton({ icon: Icon, name, onClick }: { icon: LucideIcon; name: string; onClick: () => void }) {
  return <button type="button" aria-label={name} onClick={onClick} className={`${control} group relative p-1.5`}>
    <Icon aria-hidden="true" className="size-4" />
    <span aria-hidden="true" className="pointer-events-none absolute right-0 top-full z-10 mt-1 hidden whitespace-nowrap rounded bg-zinc-800 px-2 py-1 shadow group-hover:block group-focus-visible:block">{name}</span>
  </button>;
}

function timeAxisFormatter(duration: number, interval: number, crossesLocalDay: boolean): Intl.DateTimeFormat {
  if (duration >= 86_400_000) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric',
      ...(duration >= 365 * 86_400_000 ? { year: 'numeric' } : { hour: 'numeric' }),
    });
  }
  return new Intl.DateTimeFormat(undefined, {
    ...(crossesLocalDay ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit',
    ...(interval < 60_000 ? { second: '2-digit' } : {}),
    ...(interval < 1000 ? { fractionalSecondDigits: 3 } : {}),
  });
}

/** A bounded set of observations covering the requested time range. */
export function ActivityChart({ samples, startedAt, bounds, onRangeChange, historyAction, children: historyDetails }: {
  samples: (ActivitySample & Partial<DashboardHistoryPoint>)[];
  startedAt: number;
  bounds?: [number, number];
  onRangeChange?: (range: { from: number; to: number } | null) => void;
  historyAction?: ReactNode;
  children?: ReactNode;
}) {
  const rangeDescription = useId();
  const drag = useRef<{ pointerId: number; startX: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(477);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(160, Math.floor(entry.contentRect.width)));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
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
  const observed = visible.filter((sample) => !sample.gap);
  const max = Math.max(1, ...observed.flatMap((s) => [s.parents, s.children]));
  const duration = end - start;
  const crossesLocalDay = new Date(start).toDateString() !== new Date(end).toDateString();
  const plotWidth = width - plotLeft - 12;
  const xAt = (time: number) => plotLeft + (time - start) / Math.max(1, duration) * plotWidth;
  const yAt = (count: number) => plotBottom - count / max * (plotBottom - plotTop);
  const tickStep = Math.ceil(max / 4);
  const countTicks = observed.length ? Array.from({ length: Math.ceil(max / tickStep) }, (_, i) => i * tickStep).concat(max) : [];
  // Leave room for a full inward-anchored date label and half its neighbor.
  const tickSpacing = crossesLocalDay ? 180 : 125;
  const desiredStep = duration / Math.max(1, Math.min(8, Math.floor(plotWidth / tickSpacing)));
  const preferredStep = clockSteps.find((value) => value >= desiredStep) ?? Math.ceil(desiredStep / day) * day;
  const step = preferredStep > duration ? clockSteps.filter((value) => value <= duration).at(-1) ?? 1 : preferredStep;
  const offset = new Date(start).getTimezoneOffset() * minute;
  const firstTick = Math.ceil((start - offset) / step) * step + offset;
  const timeTicks: number[] = [];
  for (let time = firstTick; time <= end; time += step) timeTicks.push(time);
  const formatTime = timeAxisFormatter(duration, step, crossesLocalDay);
  const missingDay = crossesLocalDay && (
    new Date(timeTicks[0]).toDateString() !== new Date(start).toDateString()
    || new Date(timeTicks.at(-1)!).toDateString() !== new Date(end).toDateString()
  );
  const connected = (left: typeof visible[number] | undefined, right: typeof visible[number] | undefined, key: 'parents' | 'children') =>
    left && right && !left.gap && !left.containsGap && !right.gap && !right.containsGap
      && (left.time !== right.time || left[key] !== right[key]);
  const isolated = visible.flatMap((sample, i) => {
    if (sample.gap) return [];
    const keys = (['parents', 'children'] as const).filter((key) =>
      !connected(visible[i - 1], sample, key) && !connected(sample, visible[i + 1], key));
    return keys.map((key) => ({ sample, key, index: i }));
  });
  const seriesPaths = (key: 'parents' | 'children') => {
    const paths = { exact: '', summarized: '' };
    let previous: { x: string; y: string; summarized: boolean } | undefined;
    let activePath: keyof typeof paths | undefined;
    for (const s of visible) {
      if (s.gap || s.containsGap) {
        previous = undefined;
        activePath = undefined;
        continue;
      }
      const x = xAt(s.time).toFixed(1);
      const y = yAt(s[key]).toFixed(1);
      if (previous) {
        // The first observation represents its bucket, so omitted counts affect the outgoing step.
        const style = previous.summarized ? 'summarized' : 'exact';
        if (style !== activePath) paths[style] += ` M${previous.x},${previous.y}`;
        paths[style] += ` H${x} V${y}`;
        activePath = style;
      }
      previous = { x, y, summarized: s.summarized === true };
    }
    return { exact: paths.exact.trim(), summarized: paths.summarized.trim() };
  };
  const parents = seriesPaths('parents');
  const children = seriesPaths('children');
  const pannable = duration > 0 && duration < last - first;
  const changeRange = (factor: number, shift = 0) => {
    const total = last - first;
    if (total <= 0) return;
    const width = Math.min(total, Math.max(1, (end - start) * factor));
    const center = (start + end) / 2 + Math.round((end - start) * shift);
    const nextStart = Math.max(first, Math.min(last - width, center - width / 2));
    const next: [number, number] = [Math.floor(nextStart), Math.ceil(nextStart + width)];
    if (next[0] === start && next[1] === end) return;
    setSelected(null);
    setRange(next);
    onRangeChange?.({ from: next[0], to: next[1] });
  };
  const selectAt = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!visible.length || drag.current) return;
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
    const fraction = Math.max(0, Math.min(1, (x - plotLeft) / plotWidth));
    const time = start + fraction * (end - start);
    let closest = 0;
    for (let i = 1; i < visible.length; i++) {
      if (Math.abs(visible[i].time - time) < Math.abs(visible[closest].time - time)) closest = i;
    }
    selectIndex(closest);
  };
  const hasSummary = Boolean(parents.summarized || children.summarized || isolated.some(({ sample }) => sample.summarized));
  const emptyMessage = visible.length ? 'Unobserved period in this range' : 'No observations in this range';
  const detail = selectedSample && [
    label(selectedSample.time),
    selectedSample.gap ? 'Unobserved period' : `Parents: ${selectedSample.parents} · Children: ${selectedSample.children}`,
    selectedSample.containsGap && !selectedSample.gap && 'This interval contains an unobserved period',
    selectedSample.summarized && 'Multiple observations in this interval; zoom in for detail',
  ].filter(Boolean).join(' · ');
  return (
    <section className={card}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">Observed activity</h2>
          <span className="text-[11px] text-zinc-400">Working or starting sessions · local time</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {historyAction}
          <div role="group" aria-label="Activity range" className="flex gap-1">
            <RangeButton icon={ZoomIn} name="Zoom in" onClick={() => changeRange(0.5)} />
            <RangeButton icon={ZoomOut} name="Zoom out" onClick={() => changeRange(2)} />
            <RangeButton icon={Maximize} name="Full range" onClick={() => { setSelected(null); setRange(null); onRangeChange?.(null); }} />
          </div>
        </div>
      </header>
      <ul aria-label="Activity legend" className="mt-2 flex w-fit max-w-full flex-wrap justify-end gap-x-3 gap-y-1 rounded-md bg-[#0d1117] px-2 py-1 text-[11px] text-zinc-300 ml-auto">
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-[#10b981]" />Parents</li>
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-[#38bdf8]" />Children</li>
        {hasSummary && <li className="flex items-center gap-1.5"><span className="h-0.5 w-3 bg-zinc-400/60" />Faded: summarized</li>}
      </ul>

      <div role="group" aria-label="Activity timeline" aria-describedby={rangeDescription}
        tabIndex={0} title={pannable ? 'Drag or use Left and Right to pan' : undefined}
        className="relative rounded focus-visible:outline focus-visible:outline-sky-400"
        onKeyDown={(event) => {
          if (!pannable || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
          event.preventDefault();
          changeRange(1, event.key === 'ArrowLeft' ? -0.5 : 0.5);
        }}>
        <svg ref={svgRef} viewBox={`0 0 ${width} ${plotHeight}`} role="img" aria-label="Observed concurrent working sessions"
          onPointerMove={selectAt}
          onPointerDown={(event) => {
            if (!pannable || drag.current || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, startX: event.clientX };
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            const displacement = drag.current.startX - event.clientX;
            drag.current = null;
            if (Math.abs(displacement) < 4) return;
            const scale = event.currentTarget.getBoundingClientRect().width / width;
            if (scale > 0) changeRange(1, displacement / (plotWidth * scale));
          }}
          onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}
          className={`block h-[170px] w-full tabular-nums ${pannable ? 'cursor-ew-resize touch-pan-y' : ''}`}>
          {countTicks.map((count) => <g key={count}>
            <line x1={plotLeft} x2={width - 12} y1={yAt(count)} y2={yAt(count)} stroke={count === 0 ? '#3f3f46' : '#272d38'} />
            <text x={plotLeft - 6} y={yAt(count)} dy=".33em" textAnchor="end" fill="#a1a1aa" fontSize="11">{count}</text>
          </g>)}
          {timeTicks.map((time) => {
            const x = xAt(time);
            const edge = crossesLocalDay ? 70 : 45;
            const anchor = x - plotLeft < edge ? 'start' : width - 12 - x < edge ? 'end' : 'middle';
            return <g key={time}>
              <line x1={x} x2={x} y1={observed.length ? plotTop : plotBottom - 4} y2={plotBottom} stroke="#272d38" />
              <text x={x} y={plotBottom + 18} textAnchor={anchor} fill="#a1a1aa" fontSize="11">{formatTime.format(time)}</text>
            </g>;
          })}
          <path d={parents.exact} stroke="#10b981" strokeWidth="3" fill="none" />
          <path d={children.exact} stroke="#38bdf8" strokeWidth="1.75" fill="none" />
          {parents.summarized && <path d={parents.summarized} stroke="#10b981" strokeWidth="3" strokeOpacity={0.6} fill="none" />}
          {children.summarized && <path d={children.summarized} stroke="#38bdf8" strokeWidth="1.75" strokeOpacity={0.6} fill="none" />}
          {isolated.map(({ sample, key, index: i }) => (
            <circle key={`${i}-${key}`} cx={xAt(sample.time)} cy={yAt(sample[key])}
              r={key === 'parents' ? 2.75 : 1.65} fill={key === 'parents' ? '#10b981' : '#38bdf8'}
              opacity={sample.summarized ? 0.6 : undefined} />
          ))}
          {selected && selectedSample && <line x1={xAt(selectedSample.time)} x2={xAt(selectedSample.time)} y1={plotTop} y2={plotBottom} stroke="#a1a1aa" strokeOpacity={0.65} />}
        </svg>
        <p aria-live="polite" className="pointer-events-none absolute inset-x-5 top-1/2 -translate-y-1/2 text-center text-xs text-zinc-300">{!observed.length && emptyMessage}</p>
      </div>
      <p id={rangeDescription} className={missingDay ? 'text-[11px] text-zinc-400' : 'sr-only'}>
        {label(start)} to {label(end)}.
        <span className="sr-only"> When zoomed, drag or use Left and Right to pan.</span>
      </p>
      {visible.length > 0 ? <>
        <input aria-label="Activity observation" aria-valuetext={detail} className="mt-2 h-3 w-full accent-sky-400" type="range" min={0} max={visible.length - 1} value={index} onFocus={() => { if (!selected) selectIndex(index); }} onChange={(e) => selectIndex(Number(e.target.value))} />
        <p aria-live="polite" className="min-h-4 text-xs text-zinc-300">{selected && detail}</p>
      </> : null}
      {historyDetails}
    </section>
  );
}

export function HistoryChart({ revision, recordingError }: { revision: number; recordingError?: string }) {
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
  const hasHistory = view?.first != null && view.last != null;
  const historyAction = (
    <button className={control} aria-expanded={Boolean(browse)} type="button" disabled={!hasHistory}
      title="Closed sessions since history was enabled · Browse observations in this range"
      onClick={() => { setCursors([null]); setBrowse(browse ? null : range ?? { from: view!.first!, to: view!.last! }); }}>
      History · {view?.closedCount ?? '—'} closed
    </button>
  );
  return (
    <ActivityChart samples={view?.points ?? []} startedAt={Date.now()} bounds={hasHistory ? [view.first!, view.last!] : undefined} onRangeChange={changeRange} historyAction={historyAction}>
      {recordingError && <p role="alert" className="mt-2 text-xs break-words text-rose-400">{recordingError}</p>}
      {overviewError && <p role="alert" className="mt-2 text-xs text-rose-400">{overviewError}</p>}
      {browse && <div className="mt-2 space-y-2 text-xs text-zinc-300">
        <p>Closed sessions since history was enabled: {view?.closedCount ?? '—'}</p>
        <p>Observations in this range {pageLoading ? '(loading)' : ''}</p>
        {pageError && <p role="alert" className="text-rose-400">{pageError} <button className={control} type="button" onClick={() => setPageAttempt((attempt) => attempt + 1)}>Retry observations</button></p>}
        {page && <ul aria-label="Observed activity records" tabIndex={0} className="max-h-36 space-y-1 overflow-auto rounded border border-zinc-800 p-1">{page.observations.map((s) => <li key={s.id}>{label(s.time)} · {s.gap ? 'Unobserved period' : `Parents: ${s.parents} · Children: ${s.children}`}</li>)}</ul>}
        <div className="flex flex-wrap gap-1">
          <button className={control} type="button" disabled={cursors.length <= 1} onClick={() => setCursors((previous) => previous.slice(0, -1))}>Previous page</button>
          <button className={control} type="button" disabled={!page?.next} onClick={() => { if (page?.next) setCursors((previous) => [...previous, page.next!]); }}>Next page</button>
        </div>
      </div>}
    </ActivityChart>
  );
}
