import React, { useEffect, useState } from 'react';
import type { ControlAgentContextCall, ControlAgentContextSnapshot } from '@spawnea/domain';
import { getAgentSkillPrompt } from '@spawnea/domain';
import { Check, Copy } from 'lucide-react';

interface AgentContextViewProps {
  sessionId: string;
}

export function AgentContextView({ sessionId }: AgentContextViewProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ControlAgentContextSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ControlAgentContextCall | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [outputMode, setOutputMode] = useState<'compact' | 'raw'>('compact');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const response = selected?.response as { turnId?: string; sessionId?: string } | undefined;
  const turnId = response?.turnId;

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(getAgentSkillPrompt());
      setCopyStatus('copied');
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('failed');
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopyStatus('idle'), 2000);
    }
  };

  useEffect(() => {
    let active = true;
    setOutput(null);
    if (turnId) void window.spawneaApi.getAgentContextTurn(sessionId, turnId, outputMode)
      .then((result) => { if (active) setOutput(JSON.stringify(result, null, 2)); })
      .catch((error) => { if (active) setOutput(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [sessionId, selected?.id, turnId, outputMode]);

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
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-zinc-500 truncate" title={`Root · ${snapshot.rootSessionId}`}>Root · {snapshot.rootSessionId}</span>
          <button
            type="button"
            data-testid="copy-agent-prompt-button"
            onClick={handleCopyPrompt}
            className="flex items-center gap-1 shrink-0 rounded bg-[#21262d] px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-[#30363d] hover:text-white transition-colors"
            title="Copy Spawnea CLI orchestration prompt for AI agents"
          >
            {copyStatus === 'copied' ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            <span className={copyStatus === 'failed' ? 'text-rose-400' : undefined}>
              {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : 'Copy Prompt'}
            </span>
          </button>
        </div>
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
            <span className="block truncate text-[10px] text-zinc-500">
              {(call.response as { sessionId?: string } | undefined)?.sessionId ?? 'Root'}
              {(call.response as { turnId?: string } | undefined)?.turnId ? ` / Turn ${(call.response as { turnId: string }).turnId.slice(0, 8)}` : ''}
            </span>
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
            {turnId && <div>
              <p className="mb-2 text-zinc-400">Child activity and completion are best-effort observations of bounded terminal output.</p>
              <label>Output mode <select aria-label="Output mode" value={outputMode} onChange={(event) => setOutputMode(event.target.value as 'compact' | 'raw')} className="rounded bg-[#0d1117] p-1">
                <option value="compact">Compact</option><option value="raw">Raw</option>
              </select></label>
              <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 text-[11px] text-zinc-300">{output ?? 'Loading bounded output…'}</pre>
            </div>}
            <div>
              <h4 className="mb-1 font-medium text-zinc-300">Bounded request</h4>
              <pre className="whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 text-[11px] text-zinc-300">{JSON.stringify(selected.request, null, 2)}</pre>
            </div>
            <div>
              <h4 className="mb-1 font-medium text-zinc-300">Bounded response</h4>
              <pre className="whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 text-[11px] text-zinc-300">{selected.error ?? JSON.stringify(selected.response, null, 2)}</pre>
            </div>
          </div>
        ) : <div className="text-xs text-zinc-500">Select an operation to inspect details.</div>}
      </section>
    </div>
  );
}
