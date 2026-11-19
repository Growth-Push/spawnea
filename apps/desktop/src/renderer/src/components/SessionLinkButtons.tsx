import { useEffect, useState } from 'react';
import {
  BookMarked, CircleCheck, CircleDot, CircleHelp, CircleSlash, CircleX, Clock,
  GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, MinusCircle, SkipForward,
} from 'lucide-react';
import { parseGitHubLink, type GitHubLink, type GitHubLinkStatuses } from '@spawnea/domain';

const ciIndicators = {
  failed: [CircleX, 'CI failed', 'text-red-400'],
  pending: [Clock, 'CI pending or in progress', 'text-yellow-400'],
  passed: [CircleCheck, 'CI passed', 'text-green-400'],
  cancelled: [CircleSlash, 'CI cancelled', 'text-yellow-400'],
  skipped: [SkipForward, 'CI skipped or neutral', 'text-zinc-400'],
  none: [MinusCircle, 'No CI checks', 'text-zinc-400'],
  unavailable: [CircleHelp, 'CI unavailable', 'text-zinc-400'],
} as const;

let nextStatusRequest = 0;

export function SessionLinkButtons({ sessionId, originIssueUrl, active }: { sessionId: string; originIssueUrl?: string; active: boolean }) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; links: GitHubLink[] }>({ sessionId, links: [] });
  const [statusSnapshot, setStatusSnapshot] = useState<{ sessionId: string; statuses: GitHubLinkStatuses }>();
  const [statusNow, setStatusNow] = useState(Date.now);

  useEffect(() => {
    if (!active || statusSnapshot?.sessionId !== sessionId) return;
    const deadline = Math.min(...Object.values(statusSnapshot.statuses)
      .flatMap((status) => status.freshness === 'fresh' && status.expiresAt > statusNow ? [status.expiresAt] : []));
    if (!Number.isFinite(deadline)) return;
    const timer = window.setTimeout(() => setStatusNow(Date.now()), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [active, sessionId, statusNow, statusSnapshot]);

  useEffect(() => {
    let live = true;
    let request = 0;
    let statusRequest: number | undefined;
    const cancel = () => {
      const cancelled = statusRequest;
      statusRequest = undefined;
      if (cancelled !== undefined) {
        void window.spawneaApi?.cancelSessionLinkStatuses?.(sessionId, cancelled).catch(() => {});
      }
    };
    const refresh = () => {
      if (!active || document.visibilityState !== 'visible' || !window.spawneaApi?.getSessionLinks) return;
      setStatusNow(Date.now());
      const current = ++request;
      void window.spawneaApi.getSessionLinks(sessionId).then((values) => {
        if (!live || current !== request) return;
        setSnapshot({ sessionId, links: values.flatMap((value) => {
          const parsed = parseGitHubLink(value.url);
          return parsed && parsed.kind === value.kind ? [parsed] : [];
        }) });
      }).catch(() => {});
      if (statusRequest !== undefined || !window.spawneaApi.getSessionLinkStatuses) return;
      const statusId = ++nextStatusRequest;
      statusRequest = statusId;
      void window.spawneaApi.getSessionLinkStatuses(sessionId, statusId).then((statuses) => {
        if (!live || statusRequest !== statusId) return;
        setStatusNow(Date.now());
        setStatusSnapshot({ sessionId, statuses });
      }).catch(() => {
        if (!live || statusRequest !== statusId) return;
        setStatusSnapshot((current) => current?.sessionId === sessionId ? {
          sessionId,
          statuses: Object.fromEntries(Object.entries(current.statuses).map(([url, status]) => [
            url, status.state ? { ...status, freshness: 'stale' } : status,
          ])),
        } : current);
      }).finally(() => {
        if (statusRequest === statusId) statusRequest = undefined;
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
      else cancel();
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      live = false;
      cancel();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [sessionId, active]);

  const origin = originIssueUrl ? parseGitHubLink(originIssueUrl) : undefined;
  const originLink = origin?.kind === 'issue' ? origin : undefined;
  const unique = new Map<string, GitHubLink>();
  if (originLink) unique.set(originLink.url, originLink);
  for (const link of snapshot.sessionId === sessionId ? snapshot.links : []) unique.set(link.url, link);
  if (!unique.size) return null;

  return <div role="group" aria-label="Session links" className="shrink-0 flex flex-wrap items-center gap-1.5 px-4 py-1.5 border-b border-[#30363d] max-h-24 overflow-y-auto">
    {[...unique.values()].map((link) => {
      const isOrigin = link.url === originLink?.url;
      const status = statusSnapshot?.sessionId === sessionId ? statusSnapshot.statuses[link.url] : undefined;
      const state = status?.state;
      const stale = status?.freshness === 'stale' || (status?.freshness === 'fresh' && status.expiresAt <= statusNow);
      const Icon = link.kind === 'repository' ? BookMarked
        : link.kind === 'issue' ? state === 'closed' ? CircleCheck : CircleDot
        : state === 'merged' ? GitMerge : state === 'closed' ? GitPullRequestClosed
        : state === 'draft' ? GitPullRequestDraft : GitPullRequest;
      const itemColor = state === 'open' ? 'text-green-400'
        : state === 'merged' || (state === 'closed' && link.kind === 'issue') ? 'text-purple-400'
        : state === 'closed' ? 'text-red-400' : 'text-zinc-400';
      const ci = link.kind === 'pull' ? ciIndicators[status?.ci ?? 'unavailable'] : undefined;
      const CiIcon = ci?.[0];
      const label = link.kind === 'repository' ? 'Repository' : link.kind === 'issue' ? `Issue #${link.number}` : `PR #${link.number}`;
      const identity = `${link.owner}/${link.repository}`;
      const details = [
        state && state[0].toUpperCase() + state.slice(1),
        ci?.[1],
        stale && 'GitHub status is stale',
        !state && link.kind !== 'repository' && 'GitHub status unavailable',
      ].filter(Boolean);
      const accessibleLabel = [isOrigin && 'Origin', label, identity, ...details].filter(Boolean).join(' · ');
      return <button key={link.url} type="button" title={accessibleLabel} aria-label={accessibleLabel} onClick={() => void window.spawneaApi.openExternalUrl(link.url)}
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 px-2 py-1 rounded border text-xs font-medium transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 ${isOrigin ? 'border-teal-500/25 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20' : 'border-[#30363d] bg-[#161b22] text-zinc-300 hover:text-zinc-100 hover:bg-[#21262d]'}`}>
        <Icon aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 ${itemColor}`} />
        {CiIcon && <CiIcon aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 ${ci[2]}`} />}
        {stale && <Clock aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-zinc-400" />}
        {!state && link.kind === 'issue' && <CircleHelp aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-zinc-400" />}
        <span className="shrink-0">{label}</span>
        <span className="min-w-0 truncate text-zinc-400">{identity}</span>
      </button>;
    })}
  </div>;
}
