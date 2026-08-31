import React, { useEffect, useState } from 'react';
import type {
  Session,
  FinishSessionAction,
  FinishSessionOptions,
  ManagedWorktreeInspection,
} from '@spawnea/domain';
import {
  X,
  GitMerge,
  FolderMinus,
  EyeOff,
  GitBranch,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Folder,
} from 'lucide-react';

export interface FinishSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  onFinish: (
    sessionId: string,
    action: FinishSessionAction,
    options?: FinishSessionOptions
  ) => Promise<void>;
}

export function FinishSessionModal({
  isOpen,
  onClose,
  session,
  onFinish,
}: FinishSessionModalProps): React.JSX.Element | null {
  const [selectedAction, setSelectedAction] = useState<FinishSessionAction>('integrate');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stashChanges, setStashChanges] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [inspection, setInspection] = useState<ManagedWorktreeInspection | null>(null);
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [inspectionError, setInspectionError] = useState(false);
  const currentInspection = session && inspectedSessionId === session.id ? inspection : null;

  useEffect(() => {
    setSelectedAction('integrate');
    setStashChanges(false);
    setConfirmClose(false);
    setError(null);
    setInspection(null);
    setInspectedSessionId(null);
    setIsInspecting(false);
    setInspectionError(false);
  }, [session?.id, isOpen]);

  useEffect(() => {
    if (!isOpen || !session) return;
    if (!window.spawneaApi?.inspectWorktree) {
      setInspectionError(true);
      return;
    }

    let cancelled = false;
    setIsInspecting(true);
    setInspectionError(false);
    window.spawneaApi.inspectWorktree(session.id).then((result) => {
      if (!cancelled) {
        setInspection(result);
        setInspectedSessionId(session.id);
        setIsInspecting(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setInspectionError(true);
        setIsInspecting(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, session?.id]);

  useEffect(() => {
    if (currentInspection?.state === 'integrated') {
      setSelectedAction('close');
    }
  }, [currentInspection?.state]);

  useEffect(() => {
    if (currentInspection?.isClean) {
      setStashChanges(false);
    }
  }, [currentInspection?.isClean]);

  if (!isOpen || !session) return null;

  const baseBranch = session.baseBranch || 'main';
  const taskBranch = session.branch || 'spawnea/task';
  const inspectionPending = isInspecting || (
    Boolean(window.spawneaApi?.inspectWorktree) && !currentInspection && !inspectionError
  );
  const isClean = currentInspection?.isClean === true;
  const showStashOption = !inspectionPending && !isClean;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedAction === 'ignore') {
      onClose();
      return;
    }

    if (inspectionPending) {
      setError('Wait for the worktree state check to finish before finalizing.');
      return;
    }

    if (selectedAction === 'close' && !confirmClose) {
      setError('Confirm the close action below before removing this worktree.');
      return;
    }

    if (selectedAction === 'integrate' && currentInspection?.state === 'integrated') {
      setError('This worktree is already integrated. Select Close Worktree to remove it.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (selectedAction === 'close') {
        await onFinish(session.id, selectedAction, { stashChanges });
      } else {
        await onFinish(session.id, selectedAction);
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || `Failed to ${selectedAction} worktree session`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finish-session-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-lg border border-indigo-500/20">
              <GitMerge className="w-5 h-5" />
            </div>
            <div>
              <h2 id="finish-session-title" className="text-base font-semibold text-slate-100">
                Finish Worktree Session
              </h2>
              <p className="text-xs text-slate-400">
                Choose how to finalize this isolated task workspace
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Session details context banner */}
          <div className="p-3.5 bg-slate-950/60 rounded-lg border border-slate-800/80 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Task:</span>
              <span className="font-medium text-slate-200 truncate max-w-[320px]">{session.name || session.task}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                Task Branch:
              </span>
              <code className="text-indigo-300 font-mono text-[11px] bg-indigo-950/50 px-1.5 py-0.5 rounded border border-indigo-800/40">
                {taskBranch}
              </code>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Folder className="w-3.5 h-3.5 text-slate-400" />
                Worktree Path:
              </span>
              <span className="text-slate-300 font-mono text-[11px] truncate max-w-[320px]" title={session.worktreePath}>
                {session.worktreePath}
              </span>
            </div>
          </div>

          {inspectionPending && (
            <div
              data-testid="finish-inspection-loading"
              className="p-3.5 rounded-lg border border-indigo-500/30 bg-indigo-950/20 text-xs text-indigo-200 flex items-center gap-2.5"
            >
              <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
              Checking the current worktree and Git state...
            </div>
          )}

          {inspectionError && (
            <div
              data-testid="finish-inspection-warning"
              className="p-3.5 rounded-lg border border-amber-500/30 bg-amber-950/20 text-xs text-amber-200"
            >
              Spawnea could not pre-check the worktree state. Finalization will still run its authoritative safety checks.
            </div>
          )}

          {currentInspection?.state === 'integrated' && (
            <div
              data-testid="finish-worktree-integrated-banner"
              className="p-3.5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 text-xs text-emerald-200"
            >
              <span className="font-semibold">Worktree already integrated</span>
              <span className="block mt-0.5 text-emerald-300/80">
                Branch <code className="text-emerald-200">{taskBranch}</code> is already integrated into{' '}
                <code className="text-emerald-200">{baseBranch}</code>. Select Close Worktree to remove the folder.
              </span>
            </div>
          )}

          {/* Action selection cards */}
          <div className="space-y-3">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Select Finalization Action
            </label>

            {/* Option 1: Integrate */}
            <div
              onClick={() => !isSubmitting && !inspectionPending && currentInspection?.state !== 'integrated' && setSelectedAction('integrate')}
              className={`p-3.5 rounded-xl border transition-all flex items-start gap-3.5 ${
                selectedAction === 'integrate'
                  ? 'bg-emerald-950/30 border-emerald-500/50 ring-1 ring-emerald-500/20'
                  : 'bg-slate-950/40 border-slate-800 hover:border-slate-700'
              } ${currentInspection?.state === 'integrated' || inspectionPending ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div
                className={`p-2 rounded-lg mt-0.5 ${
                  selectedAction === 'integrate'
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                <GitMerge className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-100">
                    Integrate into <span className="text-emerald-400 font-mono">{baseBranch}</span>
                  </span>
                  {selectedAction === 'integrate' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Merges the task branch into <code className="text-slate-300">{baseBranch}</code>, stops the session, deletes the worktree folder, and deletes the integrated task branch.
                </p>
              </div>
            </div>

            {/* Option 2: Close */}
            <div
              onClick={() => !isSubmitting && setSelectedAction('close')}
              className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-start gap-3.5 ${
                selectedAction === 'close'
                  ? 'bg-amber-950/30 border-amber-500/50 ring-1 ring-amber-500/20'
                  : 'bg-slate-950/40 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div
                className={`p-2 rounded-lg mt-0.5 ${
                  selectedAction === 'close'
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                <FolderMinus className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-100">
                    {isClean
                      ? 'Close Worktree (Keep Task Branch)'
                      : 'Close Worktree (Discard Changes, Keep Task Branch)'}
                  </span>
                  {selectedAction === 'close' && (
                    <CheckCircle2 className="w-4 h-4 text-amber-400" />
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Stops the session, removes the worktree directory, and <strong className="text-slate-300">preserves the task branch in Git</strong>.
                  {inspectionPending
                    ? ' Checking for local changes...'
                    : isClean
                    ? ' No local Git changes were detected.'
                    : ' Uncommitted changes are discarded unless you save them in a stash below.'}
                </p>
              </div>
            </div>

            {/* Option 3: Ignore */}
            <div
              onClick={() => !isSubmitting && setSelectedAction('ignore')}
              className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-start gap-3.5 ${
                selectedAction === 'ignore'
                  ? 'bg-slate-800/60 border-slate-600 ring-1 ring-slate-500/20'
                  : 'bg-slate-950/40 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div
                className={`p-2 rounded-lg mt-0.5 ${
                  selectedAction === 'ignore'
                    ? 'bg-slate-700 text-slate-200'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                <EyeOff className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-100">
                    Ignore / Keep Working
                  </span>
                  {selectedAction === 'ignore' && (
                    <CheckCircle2 className="w-4 h-4 text-slate-300" />
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Dismisses this dialog without mutating Git, the session, tmux processes, or disk files.
                </p>
              </div>
            </div>
          </div>

          {/* Close safety and optional preservation */}
          {selectedAction === 'close' && (
            <div className="p-3.5 rounded-lg border border-amber-500/30 bg-amber-950/20 space-y-3 text-xs">
              {inspectionPending ? (
                <div className="flex items-center gap-2.5 text-slate-300">
                  <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                  Checking whether this worktree has local changes...
                </div>
              ) : (
                <>
                  {showStashOption && (
                    <label className="flex items-start gap-2.5 cursor-pointer text-slate-200">
                      <input
                        type="checkbox"
                        checked={stashChanges}
                        onChange={(event) => setStashChanges(event.target.checked)}
                        disabled={isSubmitting}
                        className="mt-0.5 accent-amber-500"
                        data-testid="finish-stash-changes-checkbox"
                      />
                      <span>
                        <span className="font-medium">Save changes in a Git stash before closing</span>
                        <span className="block mt-0.5 text-slate-400">
                          Uses the message <code className="text-amber-300">Spawnea worktree: {taskBranch}</code> and includes untracked and ignored files.
                        </span>
                      </span>
                    </label>
                  )}
                  <label className="flex items-start gap-2.5 cursor-pointer text-slate-200">
                    <input
                      type="checkbox"
                      checked={confirmClose}
                      onChange={(event) => setConfirmClose(event.target.checked)}
                      disabled={isSubmitting}
                      className="mt-0.5 accent-amber-500"
                      data-testid="finish-close-confirm-checkbox"
                    />
                    <span>
                      I understand this will stop the session and remove the worktree.
                      {isClean
                        ? ' No local Git changes were detected.'
                        : stashChanges
                        ? ' My changes will be saved in the named stash.'
                        : ' Any uncommitted changes will be permanently discarded.'}
                    </span>
                  </label>
                </>
              )}
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-lg flex items-start gap-2.5 text-xs text-red-200 animate-in fade-in">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-red-300">Finalization Safety Block:</div>
                <div>{error}</div>
              </div>
            </div>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (selectedAction !== 'ignore' && inspectionPending) || (selectedAction === 'close' && !confirmClose)}
              className={`flex items-center gap-2 px-5 py-2 text-xs font-medium rounded-lg transition-all shadow-md disabled:opacity-50 ${
                selectedAction === 'integrate'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/40'
                  : selectedAction === 'close'
                  ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-950/40'
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-100 shadow-slate-950/40'
              }`}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Processing...</span>
                </>
              ) : (
                <span>
                  {selectedAction === 'integrate'
                    ? 'Integrate & Clean Up'
                    : selectedAction === 'close'
                    ? 'Close Worktree'
                    : 'Dismiss'}
                </span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
