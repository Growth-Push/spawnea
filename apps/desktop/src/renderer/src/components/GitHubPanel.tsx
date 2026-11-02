import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitHubCiResult, GitHubIssueMetadata, Session } from '@spawnea/domain';

type Settings = { trackerEnabled: boolean; ciEnabled: boolean };
type Link = { url: string; kind: 'issue' | 'pull'; source: string };
let refreshSequence = 0;
const pendingSettings = new Map<string, Promise<void>>();

export function GitHubPanel({ session, mode, active = true }: { session: Session; mode: 'links' | 'ci'; active?: boolean }) {
  const [settings, setSettings] = useState<Settings>({ trackerEnabled: false, ciEnabled: false });
  const [links, setLinks] = useState<Link[]>([]);
  const [issue, setIssue] = useState<GitHubIssueMetadata | null>(null);
  const [selected, setSelected] = useState('');
  const [pullInput, setPullInput] = useState('');
  const [result, setResult] = useState<GitHubCiResult | null>(null);
  const [error, setError] = useState('');
  const [settingsReady, setSettingsReady] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const settingsGeneration = useRef(0);
  const settingsSaving = useRef(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const generation = useRef(0);
  const activeRequest = useRef<string | null>(null);
  const api = window.spawneaApi;

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    let live = true;
    const current = ++settingsGeneration.current;
    settingsSaving.current = false;
    setSavingSettings(false); setSettingsReady(false); setError('');
    setSelected(''); setPullInput(''); setResult(null); setIssue(null); setLinks([]);
    if (!api?.getGitHubSettings) return () => { live = false; settingsGeneration.current += 1; };
    const pending = pendingSettings.get(session.projectId);
    const settingsRead = (pending ? pending.catch(() => {}) : Promise.resolve()).then(() => api.getGitHubSettings(session.projectId));
    Promise.all([settingsRead, api.getSessionLinks(session.id)])
      .then(([nextSettings, nextLinks]) => { if (live && current === settingsGeneration.current) { setSettings(nextSettings); setLinks(nextLinks); setSettingsReady(true); } })
      .catch(() => { if (live) setError('GitHub settings or links are unavailable.'); });
    return () => { live = false; settingsGeneration.current += 1; };
  }, [api, session.id, session.projectId]);

  useEffect(() => {
    let live = true;
    if (session.originIssueUrl && settings.trackerEnabled && api?.getGitHubIssue) {
      api.getGitHubIssue(session.id).then((value) => { if (live) setIssue(value); }).catch(() => { if (live) setIssue(null); });
    }
    return () => { live = false; };
  }, [api, session.id, session.originIssueUrl, settings.trackerEnabled]);

  useEffect(() => {
    if (mode !== 'links' || !active || !visible || !api?.getSessionLinks) return;
    let live = true;
    const timer = window.setInterval(() => {
      api.getSessionLinks(session.id).then((value) => { if (live) setLinks(value); }).catch(() => { if (live) setError('Session links are unavailable.'); });
    }, 10000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, api, mode, session.id, visible]);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!api?.getGitHubCi || !settings.ciEnabled) return;
    if (activeRequest.current) void api.cancelGitHubCi(activeRequest.current);
    const requestId = `github-refresh-${Date.now()}-${++refreshSequence}`;
    activeRequest.current = requestId;
    try {
      const value = await api.getGitHubCi(session.id, selected || undefined, requestId);
      if (current === generation.current) { setResult(value); setError(''); }
    } catch {
      if (current === generation.current) { setResult(null); setError('CI refresh failed.'); }
    } finally {
      if (activeRequest.current === requestId) activeRequest.current = null;
    }
  }, [api, session.id, selected, settings.ciEnabled]);

  useEffect(() => {
    if (mode !== 'ci' || !settings.ciEnabled || !active || !visible) return;
    setResult(null);
    void refresh();
    const timer = window.setInterval(() => {
      if (!activeRequest.current) void refresh();
    }, 60000);
    return () => { generation.current += 1; window.clearInterval(timer); if (activeRequest.current) { void api.cancelGitHubCi(activeRequest.current); activeRequest.current = null; } };
  }, [active, api, mode, refresh, settings.ciEnabled, visible]);

  const changeSettings = async (next: Settings) => {
    if (!settingsReady || settingsSaving.current) return;
    const current = settingsGeneration.current;
    settingsSaving.current = true;
    setSavingSettings(true);
    const pending = pendingSettings.get(session.projectId);
    if (pending) {
      try {
        await pending.catch(() => {});
        const latest = await api.getGitHubSettings(session.projectId);
        if (current === settingsGeneration.current) { setSettings(latest); setError('GitHub settings changed. Please try again.'); }
      } catch { if (current === settingsGeneration.current) setError('GitHub settings are unavailable.'); }
      finally { if (current === settingsGeneration.current) { settingsSaving.current = false; setSavingSettings(false); } }
      return;
    }
    const request = Promise.resolve().then(() => api.setGitHubSettings(session.projectId, next));
    pendingSettings.set(session.projectId, request);
    try { await request; if (current === settingsGeneration.current) { setSettings(next); setError(''); } }
    catch { if (current === settingsGeneration.current) setError('Could not save GitHub settings.'); }
    finally { if (pendingSettings.get(session.projectId) === request) pendingSettings.delete(session.projectId); if (current === settingsGeneration.current) { settingsSaving.current = false; setSavingSettings(false); } }
  };
  const unique = [...new Set(links.map((link) => link.url))];
  const open = (url: string) => void api.openExternalUrl(url);
  const copy = (url: string) => void api.writeClipboardText(url);

  return <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-4 text-xs text-zinc-300 space-y-3" aria-label={mode === 'ci' ? 'GitHub CI' : 'Session links'}>
    <h4 className="text-sm font-semibold text-white">{mode === 'ci' ? 'GitHub CI' : 'Links'}</h4>
    <label className="block"><input type="checkbox" disabled={!settingsReady || savingSettings} checked={settings.trackerEnabled} onChange={(event) => void changeSettings({ ...settings, trackerEnabled: event.target.checked })} /> GitHub issue metadata for this project</label>
    <label className="block"><input type="checkbox" disabled={!settingsReady || savingSettings} checked={settings.ciEnabled} onChange={(event) => void changeSettings({ ...settings, ciEnabled: event.target.checked })} /> GitHub CI for this project</label>
    {error && <p role="alert">{error}</p>}
    {mode === 'links' && <>
      <button type="button" onClick={() => { void api.getSessionLinks(session.id).then(setLinks).catch(() => setError('Session links are unavailable.')); }}>Refresh links</button>
      {session.originIssueUrl && <div><strong>Originating issue:</strong> {session.originIssueUrl} <button onClick={() => open(session.originIssueUrl!)}>Open</button> <button onClick={() => copy(session.originIssueUrl!)}>Copy</button><p>{!settings.trackerEnabled ? 'Metadata disabled' : issue ? issue.state === 'unavailable' ? 'Metadata unavailable' : `${issue.title} (${issue.state}; refreshed ${issue.fetchedAt})` : 'Metadata unavailable or loading'}</p></div>}
      {unique.length === 0 ? <p>No links captured.</p> : <ul>{unique.map((url) => <li key={url}>{url} <span>({links.filter((link) => link.url === url).map((link) => link.source).join(', ')})</span> <button onClick={() => open(url)}>Open</button> <button onClick={() => copy(url)}>Copy</button></li>)}</ul>}
    </>}
    {mode === 'ci' && <>
      <label>CI target <select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Published branch</option>{selected && !unique.includes(selected) && <option value={selected}>{selected}</option>}{unique.filter((url) => links.some((link) => link.url === url && link.kind === 'pull')).map((url) => <option key={url} value={url}>{url}</option>)}</select></label>
      <label>Pull request URL <input value={pullInput} onChange={(event) => setPullInput(event.target.value)} placeholder="https://github.com/owner/repo/pull/1" /></label>
      <button type="button" onClick={() => setSelected(pullInput.trim())}>Select pull request</button>
      <button disabled={!settings.ciEnabled} onClick={() => void refresh()}>Refresh CI</button>
      {result && <div><p>Checked commit status: {result.state}</p><p>Repository: {result.repository ?? 'unavailable'} · Checked commit: {result.sha ?? 'unavailable'}</p><p>Local HEAD: {result.localSha ?? 'unavailable'}{result.dirty ? ' · Uncommitted changes' : ''}{result.sha && result.localSha && result.sha !== result.localSha ? ' · Local HEAD differs from checked commit' : ''}</p><p>Refreshed: {result.fetchedAt}</p>{result.message && <p>{result.message}</p>}{result.retryAt && <p>Rate limited; retry after {result.retryAt}.</p>}<ul>{result.checks.map((check, index) => <li key={`${check.key}:${index}`}>{check.name}: {check.state} {check.url && <button onClick={() => open(check.url!)}>Open details</button>}</li>)}</ul></div>}
    </>}
  </section>;
}
