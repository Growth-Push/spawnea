import React, { useEffect, useMemo, useState } from 'react';
import type {
  LocalDiscoveryPreviewChange,
  LocalDiscoveryScanResult,
  LocalDiscoverySelection,
  OperationalCatalog,
} from '@spawnea/domain';
import { AlertCircle, CheckCircle2, Loader2, Radar, ShieldCheck, X } from 'lucide-react';

interface LocalDiscoveryModalProps {
  isOpen: boolean;
  catalog: OperationalCatalog | null;
  onClose: () => void;
  onApplied: () => Promise<void>;
}

type HostDraft = LocalDiscoverySelection['hosts'][number] & { selected: boolean };
type HarnessDraft = LocalDiscoverySelection['harnesses'][number] & { selected: boolean };

export function LocalDiscoveryModal({ isOpen, catalog, onClose, onApplied }: LocalDiscoveryModalProps): React.JSX.Element | null {
  const [phase, setPhase] = useState<'intro' | 'selection' | 'preview'>('intro');
  const [scan, setScan] = useState<LocalDiscoveryScanResult | null>(null);
  const [hosts, setHosts] = useState<HostDraft[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessDraft[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [changes, setChanges] = useState<LocalDiscoveryPreviewChange[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPhase('intro');
      setScan(null);
      setHosts([]);
      setHarnesses([]);
      setPreviewId(null);
      setChanges([]);
      setError(null);
    }
  }, [isOpen]);

  const selectedCount = useMemo(
    () => hosts.filter((item) => item.selected).length + harnesses.filter((item) => item.selected).length,
    [hosts, harnesses]
  );

  if (!isOpen) return null;

  const runScan = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const result = await window.spawneaApi.scanLocalSetup();
      setScan(result);
      setHosts(result.hosts.map((suggestion) => {
        const existing = catalog?.hosts[suggestion.suggestedHostId];
        return {
          selected: false,
          suggestionKey: suggestion.key,
          hostId: suggestion.suggestedHostId,
          name: existing?.name ?? suggestion.suggestedName,
          user: existing?.ssh?.user ?? '',
          port: typeof existing?.ssh?.port === 'number' ? existing.ssh.port : undefined,
          mode: existing ? 'update' : 'add',
        };
      }));
      const defaultLocalHost = result.localHosts[0]?.id ?? '';
      setHarnesses(result.harnesses.map((suggestion) => {
        const existing = catalog?.hosts[defaultLocalHost]?.harnesses[suggestion.candidateId];
        return {
          selected: false,
          candidateId: suggestion.candidateId,
          hostId: defaultLocalHost,
          harnessId: suggestion.candidateId,
          name: existing?.name ?? suggestion.name,
          mode: existing ? 'update' : 'add',
        };
      }));
      setPhase('selection');
    } catch (err: any) {
      setError(err?.message || 'The local scan could not be completed.');
    } finally {
      setIsBusy(false);
    }
  };

  const buildPreview = async () => {
    if (!scan || selectedCount === 0) return;
    setIsBusy(true);
    setError(null);
    try {
      const input: LocalDiscoverySelection = {
        scanId: scan.scanId,
        hosts: hosts.filter((item) => item.selected).map(({ selected: _selected, ...item }) => ({
          ...item,
          mode: catalog?.hosts[item.hostId] ? 'update' : 'add',
        })),
        harnesses: harnesses.filter((item) => item.selected).map(({ selected: _selected, ...item }) => ({
          ...item,
          mode: catalog?.hosts[item.hostId]?.harnesses[item.harnessId] ? 'update' : 'add',
        })),
      };
      const result = await window.spawneaApi.previewLocalDiscovery(input);
      if (!result.success || !result.previewId) {
        setError(result.errors.join('\n') || 'The proposed catalog update is invalid.');
        return;
      }
      setPreviewId(result.previewId);
      setChanges(result.changes);
      setPhase('preview');
    } catch (err: any) {
      setError(err?.message || 'The catalog preview could not be created.');
    } finally {
      setIsBusy(false);
    }
  };

  const applyPreview = async () => {
    if (!previewId) return;
    setIsBusy(true);
    setError(null);
    try {
      const result = await window.spawneaApi.applyLocalDiscovery(previewId);
      if (!result.success) {
        setError(result.errors?.map((item) => item.message).join('\n') || 'The catalog was not updated.');
        if (result.conflict) setPhase('selection');
        return;
      }
      await onApplied();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'The catalog was not updated.');
    } finally {
      setIsBusy(false);
    }
  };

  const updateHarnessTarget = (index: number, hostId: string) => {
    setHarnesses((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      return { ...item, hostId, mode: catalog?.hosts[hostId]?.harnesses[item.harnessId] ? 'update' : 'add' };
    }));
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="local-discovery-title" className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="h-14 px-5 border-b border-[#30363d] flex items-center justify-between bg-[#12161c] shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-cyan-500/20 text-cyan-300 flex items-center justify-center"><Radar className="w-4 h-4" /></div>
            <div><h3 id="local-discovery-title" className="font-semibold text-sm text-white">Discover local setup</h3><p className="text-[10px] text-zinc-500">Explicit, read-only scan with confirmed catalog changes</p></div>
          </div>
          <button type="button" onClick={onClose} disabled={isBusy} className="p-1 rounded text-zinc-400 hover:text-white hover:bg-[#21262d] disabled:opacity-50" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {error && <div data-testid="local-discovery-error" className="whitespace-pre-line p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs flex gap-2"><AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span></div>}

          {phase === 'intro' && (
            <div className="space-y-4">
              <div className="flex gap-3 p-4 rounded-lg border border-cyan-500/25 bg-cyan-500/5">
                <ShieldCheck className="w-5 h-5 text-cyan-300 shrink-0" />
                <div className="text-xs text-zinc-300 space-y-2 leading-relaxed">
                  <p className="font-semibold text-white">Nothing runs or changes until you ask.</p>
                  <p>The scan reads the local <code className="text-cyan-200">/etc/hosts</code> file and checks the executable bit for a fixed allowlist: Claude, Codex, Hermes, OpenCode, and a shell.</p>
                  <p>It does not execute commands, inspect versions, use the network, connect over SSH, or modify the catalog. Suspicious hosts lines are discarded in full.</p>
                </div>
              </div>
              <p className="text-xs text-zinc-500">After scanning, every item is unselected. You can edit catalog fields, review the exact before/after values, and confirm separately.</p>
            </div>
          )}

          {phase === 'selection' && scan && (
            <div className="space-y-5">
              {scan.warnings.map((warning) => <div key={warning} className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded p-2.5">{warning}</div>)}
              <section className="space-y-2">
                <div><h4 className="text-xs font-semibold text-white">Host aliases from /etc/hosts</h4><p className="text-[10px] text-zinc-500">Unverified suggestions. Selecting one creates or explicitly updates an SSH catalog host; no connection is attempted.</p></div>
                {scan.hosts.length === 0 && <p className="text-xs text-zinc-500">No eligible host aliases found.</p>}
                {scan.hosts.map((suggestion, index) => {
                  const draft = hosts[index];
                  return <div key={suggestion.key} className="grid grid-cols-[auto_1fr_1fr] gap-2 items-center p-2.5 rounded border border-[#30363d] bg-[#0d1117]">
                    <input aria-label={`Select host ${suggestion.alias}`} type="checkbox" checked={draft?.selected ?? false} onChange={(event) => setHosts((current) => current.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item))} />
                    <div><div className="text-xs text-zinc-200 font-mono">{suggestion.alias}</div><div className="text-[10px] text-zinc-500">{suggestion.address} · target remains this discovered alias</div></div>
                    <div className="grid grid-cols-2 gap-1.5"><input aria-label={`Host ID ${suggestion.alias}`} value={draft?.hostId ?? ''} onChange={(event) => setHosts((current) => current.map((item, i) => i === index ? { ...item, hostId: event.target.value } : item))} className="px-2 py-1.5 bg-[#161b22] border border-[#30363d] rounded text-[11px]" /><input aria-label={`Host name ${suggestion.alias}`} value={draft?.name ?? ''} onChange={(event) => setHosts((current) => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} className="px-2 py-1.5 bg-[#161b22] border border-[#30363d] rounded text-[11px]" /></div>
                  </div>;
                })}
              </section>

              <section className="space-y-2">
                <div><h4 className="text-xs font-semibold text-white">Allowlisted local harnesses</h4><p className="text-[10px] text-zinc-500">Only filesystem presence and executable permission were checked. Nothing was invoked.</p></div>
                {scan.harnesses.map((suggestion, index) => {
                  const draft = harnesses[index];
                  return <div key={suggestion.candidateId} className={`grid grid-cols-[auto_1fr_180px] gap-2 items-center p-2.5 rounded border border-[#30363d] bg-[#0d1117] ${!suggestion.found ? 'opacity-50' : ''}`}>
                    <input aria-label={`Select harness ${suggestion.name}`} type="checkbox" disabled={!suggestion.found || scan.localHosts.length === 0} checked={draft?.selected ?? false} onChange={(event) => setHarnesses((current) => current.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item))} />
                    <div><div className="text-xs text-zinc-200">{suggestion.name} <span className={suggestion.found ? 'text-emerald-300' : 'text-zinc-500'}>· {suggestion.found ? 'found' : 'not found'}</span></div><div className="text-[10px] text-zinc-500 font-mono break-all">{suggestion.resolvedPath ?? suggestion.command}</div></div>
                    <select aria-label={`Local host for ${suggestion.name}`} value={draft?.hostId ?? ''} disabled={!suggestion.found} onChange={(event) => updateHarnessTarget(index, event.target.value)} className="px-2 py-1.5 bg-[#161b22] border border-[#30363d] rounded text-[11px]">{scan.localHosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select>
                  </div>;
                })}
              </section>
            </div>
          )}

          {phase === 'preview' && (
            <div className="space-y-3">
              <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200"><strong>Confirmation required.</strong> These are the exact catalog fields that will be added or replaced. Unlisted entries remain unchanged.</div>
              {changes.map((change) => <div key={change.path} className="rounded-lg border border-[#30363d] overflow-hidden text-[11px]">
                <div className="px-3 py-2 bg-[#0d1117] font-mono text-cyan-200">{change.operation.toUpperCase()} {change.path}</div>
                <div className="grid grid-cols-2 divide-x divide-[#30363d]"><div className="p-3"><div className="text-[10px] uppercase text-zinc-500 mb-1">Before</div><pre className="whitespace-pre-wrap break-all text-rose-200">{change.before === undefined ? '(not present)' : JSON.stringify(change.before, null, 2)}</pre></div><div className="p-3"><div className="text-[10px] uppercase text-zinc-500 mb-1">After</div><pre className="whitespace-pre-wrap break-all text-emerald-200">{JSON.stringify(change.after, null, 2)}</pre></div></div>
              </div>)}
              <p className="text-[10px] text-zinc-500">Spawnea will re-read the catalog before writing. If it changed since this preview, confirmation is rejected and nothing is overwritten.</p>
              {changes.some((change) => change.path.split('.').length === 2) && <p className="text-[10px] text-amber-300">After confirmation, a selected host becomes active catalog configuration. The discovery scan itself makes no connection, but Spawnea's normal host-health monitoring may later try the configured SSH target.</p>}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#30363d] flex justify-between items-center bg-[#12161c] shrink-0">
          <button type="button" onClick={onClose} disabled={isBusy} className="px-3 py-2 text-xs text-zinc-400 hover:text-white disabled:opacity-50">Cancel</button>
          {phase === 'intro' && <button type="button" data-testid="local-discovery-scan" onClick={runScan} disabled={isBusy} className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold disabled:opacity-50">{isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />} Scan local setup</button>}
          {phase === 'selection' && <button type="button" data-testid="local-discovery-preview" onClick={buildPreview} disabled={isBusy || selectedCount === 0} className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold disabled:opacity-50">{isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Review {selectedCount} change{selectedCount === 1 ? '' : 's'}</button>}
          {phase === 'preview' && <div className="flex gap-2"><button type="button" onClick={() => setPhase('selection')} disabled={isBusy} className="px-3 py-2 text-xs text-zinc-300 border border-[#30363d] rounded-lg">Back</button><button type="button" data-testid="local-discovery-confirm" onClick={applyPreview} disabled={isBusy} className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-50">{isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Confirm and update catalog</button></div>}
        </div>
      </div>
    </div>
  );
}
