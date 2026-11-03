import { useEffect, useState } from 'react';
import { BookMarked, CircleDot, GitPullRequest } from 'lucide-react';
import { parseGitHubLink, type GitHubLink } from '@spawnea/domain';

export function SessionLinkButtons({ sessionId, originIssueUrl, active }: { sessionId: string; originIssueUrl?: string; active: boolean }) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; links: GitHubLink[] }>({ sessionId, links: [] });

  useEffect(() => {
    let live = true;
    let request = 0;
    const refresh = () => {
      if (!active || document.visibilityState !== 'visible' || !window.spawneaApi?.getSessionLinks) return;
      const current = ++request;
      void window.spawneaApi.getSessionLinks(sessionId).then((values) => {
        if (!live || current !== request) return;
        setSnapshot({ sessionId, links: values.flatMap((value) => {
          const parsed = parseGitHubLink(value.url);
          return parsed && parsed.kind === value.kind ? [parsed] : [];
        }) });
      }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
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
      const Icon = link.kind === 'repository' ? BookMarked : link.kind === 'issue' ? CircleDot : GitPullRequest;
      const label = link.kind === 'repository' ? 'Repository' : link.kind === 'issue' ? `Issue #${link.number}` : `PR #${link.number}`;
      const identity = `${link.owner}/${link.repository}`;
      const accessibleLabel = `${isOrigin ? 'Origin · ' : ''}${label} · ${identity}`;
      return <button key={link.url} type="button" title={accessibleLabel} aria-label={accessibleLabel} onClick={() => void window.spawneaApi.openExternalUrl(link.url)}
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 px-2 py-1 rounded border text-xs font-medium transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 ${isOrigin ? 'border-teal-500/25 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20' : 'border-[#30363d] bg-[#161b22] text-zinc-300 hover:text-zinc-100 hover:bg-[#21262d]'}`}>
        <Icon className="w-3.5 h-3.5 shrink-0" /><span className="shrink-0">{label}</span><span className="truncate text-zinc-400">{identity}</span>
      </button>;
    })}
  </div>;
}
