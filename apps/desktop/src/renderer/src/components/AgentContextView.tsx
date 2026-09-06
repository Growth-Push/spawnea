import React, { useEffect, useState } from 'react';
import type { ControlAgentContextCall, ControlAgentContextSnapshot } from '@spawnea/domain';

interface AgentContextViewProps {
  sessionId: string;
}

export function AgentContextView({ sessionId }: AgentContextViewProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ControlAgentContextSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ControlAgentContextCall | null>(null);

  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setSelected(null);
    setLoadError(null);
    const load = async () => {
      try {
        const next = await window.spawneaApi.getAgentContext(sessionId);
        if (!active) return;
        setLoadError(null);
        setSnapshot(next);
        setSelected((current) => next.calls.find((call) => call.id === current?.id) ?? next.calls.at(-1) ?? null);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      }
    };
    let timer: number | undefined;
    const schedule = () => { timer = window.setTimeout(async () => { await load(); if (active) schedule(); }, 1_500); };
    void load().finally(() => { if (active) schedule(); });
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sessionId]);

  if (!snapshot) return <div data-testid="agent-context-unavailable" className="text-xs text-amber-300">{loadError ?? 'Loading volatile agent context…'}</div>;

  return (
    <div data-testid="agent-context-view" className="h-full grid grid-cols-[minmax(220px,30%)_1fr] overflow-hidden rounded-lg border border-[#30363d] bg-[#161b22]">
      <aside className="overflow-y-auto border-r border-[#30363d] p-3">
        <div className="mb-3 text-[11px] text-zinc-500">Root · {snapshot.rootSessionId}</div>
        {snapshot.calls.length === 0 ? (
          <div data-testid="agent-context-unavailable" className="rounded border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-200">
            {snapshot.volatileNotice}
          </div>
        ) : snapshot.calls.map((call) => (
          <button
            type="button"
            key={call.id}
            onClick={() => setSelected(call)}
            className={`mb-1 block w-full truncate rounded px-2 py-1.5 text-left text-xs ${selected?.id === call.id ? 'bg-[#30363d] text-emerald-300' : 'text-zinc-300 hover:bg-[#21262d]'}`}
            title={call.operation}
          >
            {call.operation === 'getTurn' && call.status === 'unchanged' ? 'wait_get' : call.operation}
            {call.repeatCount > 1 ? ` (${call.repeatCount})` : ''}
            <span className="ml-2 text-[10px] text-zinc-500">{call.status}</span>
          </button>
        ))}
      </aside>
      <section className="overflow-auto p-4">
        <p className="mb-3 text-[11px] text-zinc-500">{snapshot.volatileNotice}</p>
        {selected ? (
          <div className="space-y-4 text-xs">
            <div><span className="text-zinc-500">Operation:</span> <span className="text-zinc-200">{selected.operation}</span></div>
            <div><span className="text-zinc-500">Status:</span> <span className="text-zinc-200">{selected.status}</span></div>
            <div>
              <h4 className="mb-1 font-medium text-zinc-300">Bounded request</h4>
              <pre className="whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 text-[11px] text-zinc-300">{JSON.stringify(selected.request, null, 2)}</pre>
            </div>
            <div>
              <h4 className="mb-1 font-medium text-zinc-300">Bounded response</h4>
              <pre className="whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 text-[11px] text-zinc-300">{selected.error ?? JSON.stringify(selected.response, null, 2)}</pre>
            </div>
          </div>
        ) : <div className="text-xs text-zinc-500">Select an MCP call to inspect its bounded details.</div>}
      </section>
    </div>
  );
}
