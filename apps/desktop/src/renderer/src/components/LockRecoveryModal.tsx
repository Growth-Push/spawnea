import { useEffect, useRef, useState } from 'react';
import type { CloseWorktreeResponse } from '@spawnea/domain';

type Blocked = Extract<CloseWorktreeResponse, { ok: false }>;
export function LockRecoveryModal({ blocked, onCancel, onRecover }: { blocked: Blocked; onCancel: () => void; onRecover: () => Promise<void> }): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const section = dialog.current;
    section?.querySelector<HTMLElement>('input, button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !section) return;
      const controls = Array.from(section.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="lock-recovery-title" className="max-w-xl p-6 rounded-xl bg-slate-900 text-slate-100 border border-amber-700 space-y-4">
      <h2 id="lock-recovery-title">Worktree finalization blocked</h2>
      <p>Session: {blocked.sessionId}. The runtime may be stopped; finalization is not complete.</p>
      <p role="alert">{blocked.message}</p>
      {blocked.lockPath && <p>Exact lock: <code>{blocked.lockPath}</code></p>}
      {blocked.backupPath && <p>Retained backup: <code>{blocked.backupPath}</code></p>}
      {blocked.quarantinePath && <p>Retained exact-lock quarantine: <code>{blocked.quarantinePath}</code></p>}
      {blocked.recoveryPlanId && <>
        <p>Spawnea will verify a full backup outside the worktree, atomically move only this index.lock to a retained quarantine on the repository filesystem, and retry your selected close policy. A durable receipt records both locations. The task branch and backup will be retained.</p>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />I accept that this lock has unknown ownership. Process inspection cannot prove it is orphaned or exclude a new writer. Recovery may interfere with an unobserved Git operation. This confirmation accepts that residual risk; it is not proof of safety.</label>
      </>}
      <div className="flex gap-4">
        <button disabled={busy} onClick={onCancel}>Cancel</button>
        {blocked.recoveryPlanId && <button disabled={busy || !confirmed} onClick={async () => { setBusy(true); try { await onRecover(); } finally { setBusy(false); } }}>{busy ? 'Recovering...' : 'Back up, recover and close'}</button>}
      </div>
    </section>
  </div>;
}
