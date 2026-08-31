import React from 'react';
import type { ControlFinalizationRequest } from '@spawnea/domain';
import { AlertTriangle, CheckCircle2, GitMerge, Loader2, ShieldAlert, XCircle } from 'lucide-react';

interface ControlFinalizationModalProps {
  request: ControlFinalizationRequest | null;
  onDecision: (requestId: string, decision: 'approve' | 'reject') => Promise<void>;
  onDismiss: (requestId: string) => void;
}

export function ControlFinalizationModal({
  request,
  onDecision,
  onDismiss,
}: ControlFinalizationModalProps): React.JSX.Element | null {
  // A validated MCP close executes in Main and must never fall through to a
  // renderer confirmation surface, even if a stale event is delivered.
  if (!request || request.mode !== 'ui-confirmation') return null;

  const isPending = request.status === 'pending';
  const isExecuting = request.status === 'executing';
  const isResolved = !isPending && !isExecuting;
  const isIntegrate = request.action === 'integrate';
  const actionLabel = isIntegrate ? 'Integrate branch' : 'Close worktree';
  const destructiveSummary = isIntegrate
    ? `Spawnea will stop the session, merge ${request.branch} into ${request.baseBranch}, remove the worktree, and delete the integrated task branch.`
    : request.dirtyChanges === 'stash'
      ? 'Spawnea will stop the session, stash all local changes, remove the worktree, and preserve the task branch.'
      : 'Spawnea will permanently discard tracked and untracked local changes, stop the session, remove the worktree, and preserve the task branch.';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="control-finalization-title"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-amber-500/35 bg-slate-900 shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-slate-800 bg-amber-950/20 px-6 py-4">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-amber-300">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div>
            <h2 id="control-finalization-title" className="font-semibold text-slate-100">
              External MCP request — confirmation required
            </h2>
            <p className="mt-1 text-xs text-amber-200/80">
              Nothing has been executed. Spawnea will only continue if you confirm here.
            </p>
          </div>
        </header>

        <div className="space-y-4 p-6">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs">
            <dt className="text-slate-500">Action</dt>
            <dd className="font-medium text-slate-100">{actionLabel}</dd>
            <dt className="text-slate-500">Session</dt>
            <dd className="text-slate-200">{request.sessionName}</dd>
            <dt className="text-slate-500">Task branch</dt>
            <dd className="break-all font-mono text-indigo-300">{request.branch}</dd>
            <dt className="text-slate-500">Base branch</dt>
            <dd className="break-all font-mono text-slate-300">{request.baseBranch}</dd>
            <dt className="text-slate-500">Worktree</dt>
            <dd className="break-all font-mono text-slate-300">{request.worktreePath}</dd>
          </dl>

          <div className={`flex gap-3 rounded-lg border p-4 text-sm ${
            request.dirtyChanges === 'discard'
              ? 'border-rose-500/40 bg-rose-950/25 text-rose-100'
              : 'border-amber-500/30 bg-amber-950/20 text-amber-100'
          }`}>
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>{destructiveSummary}</p>
          </div>

          {request.status === 'completed' && (
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <CheckCircle2 className="h-4 w-4" /> Action completed successfully.
            </div>
          )}
          {request.status === 'rejected' && (
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <XCircle className="h-4 w-4" /> Request rejected. No finalization action was executed.
            </div>
          )}
          {request.status === 'failed' && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-950/25 p-3 text-sm text-rose-200">
              <strong>Action failed:</strong> {request.error || 'Unknown error'}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-3 border-t border-slate-800 bg-slate-950/30 px-6 py-4">
          {isPending && (
            <>
              <button
                type="button"
                onClick={() => void onDecision(request.id, 'reject')}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Reject request
              </button>
              <button
                type="button"
                onClick={() => void onDecision(request.id, 'approve')}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                  request.dirtyChanges === 'discard'
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-amber-600 hover:bg-amber-500'
                }`}
              >
                <GitMerge className="h-4 w-4" /> Confirm: {actionLabel}
              </button>
            </>
          )}
          {isExecuting && (
            <span className="flex items-center gap-2 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" /> Executing confirmed action…
            </span>
          )}
          {isResolved && (
            <button
              type="button"
              onClick={() => onDismiss(request.id)}
              className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-600"
            >
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
