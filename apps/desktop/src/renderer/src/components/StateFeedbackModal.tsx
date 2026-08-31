import React, { useState, useEffect } from 'react';
import type {
  Session,
  Server,
  Agent,
  SessionStatus,
  StateFeedbackSnapshot,
  StateFeedbackReport,
  StateFeedbackResult,
} from '@spawnea/domain';
import { StatusBadge } from './StatusBadge';
import {
  MessageSquarePlus,
  X,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  Terminal,
  FileCode,
  Sparkles,
  Play,
  Hand,
  Clock,
  CheckCircle2,
  XCircle,
  Unplug,
} from 'lucide-react';

interface StateFeedbackModalProps {
  isOpen: boolean;
  session: Session | null;
  server?: Server;
  agent?: Agent;
  onClose: () => void;
}

const STATUS_OPTIONS: {
  status: SessionStatus;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}[] = [
  {
    status: 'working',
    label: 'Working / Busy',
    desc: 'Generating output or executing code actively',
    icon: Play,
    color: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  },
  {
    status: 'needs_input',
    label: 'Needs Input',
    desc: 'Waiting for interactive user prompt / confirmation',
    icon: Hand,
    color: 'text-rose-400 border-rose-500/30 bg-rose-500/10',
  },
  {
    status: 'idle',
    label: 'Idle',
    desc: 'At prompt or ready for next instruction',
    icon: Clock,
    color: 'text-zinc-300 border-zinc-500/30 bg-zinc-500/10',
  },
  {
    status: 'done',
    label: 'Done',
    desc: 'Process / command completed successfully',
    icon: CheckCircle2,
    color: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  },
  {
    status: 'error',
    label: 'Error',
    desc: 'Execution failed, crashed, or exited with error code',
    icon: XCircle,
    color: 'text-rose-500 border-rose-600/30 bg-rose-600/10',
  },
  {
    status: 'disconnected',
    label: 'Disconnected',
    desc: 'Detached PTY or host unreachable',
    icon: Unplug,
    color: 'text-zinc-500 border-zinc-600/30 bg-zinc-600/10',
  },
];

export function StateFeedbackModal({
  isOpen,
  session,
  server: _server,
  agent,
  onClose,
}: StateFeedbackModalProps): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<StateFeedbackSnapshot | null>(null);
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const [expectedStatus, setExpectedStatus] = useState<SessionStatus>('needs_input');
  const [userNotes, setUserNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<StateFeedbackResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isSubmitting, onClose]);

  useEffect(() => {
    if (!isOpen || !session) {
      setSnapshot(null);
      setSnapshotError(null);
      setUserNotes('');
      setSubmitResult(null);
      setSubmitError(null);
      setCopied(false);
      return;
    }

    const fetchSnapshot = async () => {
      setIsLoadingSnapshot(true);
      setSnapshotError(null);
      try {
        if (window.spawneaApi?.getStateSnapshot) {
          const res = await window.spawneaApi.getStateSnapshot(session.id);
          setSnapshot(res);
          // Suggest an alternate expected status by default
          if (res.detectedStatus === 'idle') {
            setExpectedStatus('needs_input');
          } else if (res.detectedStatus === 'working') {
            setExpectedStatus('needs_input');
          } else if (res.detectedStatus === 'needs_input') {
            setExpectedStatus('idle');
          } else {
            setExpectedStatus('needs_input');
          }
        } else {
          // Fallback if running outside desktop API bridge
          setSnapshot({
            sessionId: session.id,
            sessionName: session.name,
            harness: agent?.harness || 'claude',
            worktreePath: session.worktreePath,
            branch: session.branch,
            detectedStatus: session.status,
            confidence: 0.75,
            source: 'tmux',
            reason: 'Simulated feedback snapshot',
            tailLines: ['Terminal output lines...', 'Confirm changes? [y/N] '],
            capturedAt: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        setSnapshotError(err.message || 'Failed to capture live session snapshot');
      } finally {
        setIsLoadingSnapshot(false);
      }
    };

    fetchSnapshot();
  }, [isOpen, session?.id, agent?.harness]);

  if (!isOpen || !session) return null;

  const handleSubmit = async () => {
    if (!session) return;
    setIsSubmitting(true);
    setSubmitError(null);

    const report: StateFeedbackReport = {
      sessionId: session.id,
      sessionName: session.name,
      harness: snapshot?.harness || agent?.harness || agent?.command,
      worktreePath: session.worktreePath,
      branch: session.branch,
      detectedStatus: snapshot?.detectedStatus || session.status,
      detectedSource: snapshot?.source || 'tmux',
      detectedConfidence: snapshot?.confidence || 0.7,
      detectedPrompt: snapshot?.detectedPrompt,
      detectionReason: snapshot?.reason || '',
      expectedStatus,
      userNotes: userNotes.trim(),
      tailLines: snapshot?.tailLines || [],
      timestamp: new Date().toISOString(),
    };

    try {
      if (window.spawneaApi?.submitStateFeedback) {
        const res = await window.spawneaApi.submitStateFeedback(report);
        setSubmitResult(res);
      } else {
        // Fallback for tests/mock
        setSubmitResult({
          success: true,
          filePath: `~/.config/spawnea/feedback/state-feedback-${session.id}.json`,
          fixtureJson: JSON.stringify(report, null, 2),
        });
      }
    } catch (err: any) {
      setSubmitError(err.message || 'Failed to save feedback fixture');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyFixture = () => {
    if (!submitResult?.fixtureJson) return;
    navigator.clipboard.writeText(submitResult.fixtureJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      data-testid="state-feedback-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div
        className="bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-modal-title"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d] bg-[#0d1117] shrink-0">
          <div className="flex items-center gap-2.5 text-purple-400">
            <MessageSquarePlus className="w-5 h-5" />
            <h2 id="feedback-modal-title" className="text-base font-semibold text-zinc-100">
              Report State Detection Feedback
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded-md hover:bg-[#21262d]"
            aria-label="Close modal"
            data-testid="feedback-modal-close-icon"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5 text-sm overflow-y-auto flex-1">
          {isLoadingSnapshot ? (
            <div className="py-12 flex flex-col items-center justify-center text-zinc-400 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
              <span>Capturing terminal snapshot and current state signals...</span>
            </div>
          ) : snapshotError ? (
            <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Failed to capture session snapshot</p>
                <p className="text-rose-200/90 mt-0.5">{snapshotError}</p>
              </div>
            </div>
          ) : submitResult ? (
            /* Success Feedback Card */
            <div className="space-y-4 py-2 animate-in fade-in duration-200" data-testid="feedback-success-card">
              <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 space-y-2">
                <div className="flex items-center gap-2 font-medium text-emerald-300">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <span>Feedback Fixture Saved Successfully!</span>
                </div>
                <p className="text-xs text-emerald-200/80">
                  Saved test fixture to:
                </p>
                <code className="block p-2 bg-black/40 rounded text-xs font-mono text-emerald-300 break-all select-all">
                  {submitResult.filePath}
                </code>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span className="font-semibold uppercase tracking-wider">Test Fixture JSON</span>
                  <button
                    type="button"
                    onClick={handleCopyFixture}
                    data-testid="copy-fixture-button"
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-[#21262d] hover:bg-[#30363d] text-zinc-200 transition-colors cursor-pointer border border-[#30363d]"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied to Clipboard!' : 'Copy Fixture JSON'}</span>
                  </button>
                </div>
                <pre className="p-3 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs font-mono text-zinc-300 max-h-48 overflow-y-auto">
                  {submitResult.fixtureJson}
                </pre>
              </div>
            </div>
          ) : (
            <>
              {/* Context Summary */}
              <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Current Detection</span>
                    <StatusBadge status={snapshot?.detectedStatus || session.status} />
                  </div>
                  {snapshot && (
                    <span className="text-[11px] font-mono text-zinc-500">
                      Confidence: {Math.round(snapshot.confidence * 100)}% ({snapshot.source})
                    </span>
                  )}
                </div>

                {snapshot?.reason && (
                  <div className="text-xs text-zinc-300 bg-[#161b22] px-3 py-1.5 rounded border border-[#21262d]">
                    <span className="text-zinc-500">Reason: </span>
                    <span className="font-mono text-zinc-200">{snapshot.reason}</span>
                  </div>
                )}
              </div>

              {/* Terminal Tail Snapshot Preview */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <div className="flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-zinc-500" />
                    <span className="font-semibold uppercase tracking-wider">Captured Terminal Tail ({snapshot?.tailLines?.length || 0} lines)</span>
                  </div>
                </div>
                <div
                  data-testid="terminal-tail-preview"
                  className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3 max-h-44 overflow-y-auto font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text"
                >
                  {snapshot?.tailLines && snapshot.tailLines.length > 0 ? (
                    snapshot.tailLines.map((line, idx) => (
                      <div key={idx} className="hover:bg-white/5 px-1 rounded">
                        {line || ' '}
                      </div>
                    ))
                  ) : (
                    <span className="text-zinc-600 italic">No recent terminal output captured.</span>
                  )}
                </div>
              </div>

              {/* Expected Status Selector */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                  <span>What should the status be? (Expected Status)</span>
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Expected Status">
                  {STATUS_OPTIONS.map((opt) => {
                    const Icon = opt.icon;
                    const isSelected = expectedStatus === opt.status;
                    return (
                      <button
                        type="button"
                        key={opt.status}
                        data-testid={`expected-status-${opt.status}`}
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setExpectedStatus(opt.status)}
                        className={`flex flex-col items-start p-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                          isSelected
                            ? `${opt.color} ring-1 ring-purple-500/50 shadow-sm`
                            : 'bg-[#0d1117] border-[#30363d] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 font-medium text-xs">
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          <span>{opt.label}</span>
                        </div>
                        <span className="text-[10px] text-zinc-500 mt-1 line-clamp-1">{opt.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* User Notes Commentary Input */}
              <div className="space-y-1.5">
                <label htmlFor="feedback-user-notes" className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  Optional Commentary / What Happened?
                </label>
                <textarea
                  id="feedback-user-notes"
                  data-testid="feedback-notes-input"
                  rows={2}
                  value={userNotes}
                  onChange={(e) => setUserNotes(e.target.value)}
                  placeholder="e.g. Agent asked a confirmation prompt [y/N] but state stayed as working..."
                  className="w-full px-3 py-2 text-xs bg-[#0d1117] border border-[#30363d] rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-purple-500 transition-colors resize-none"
                />
              </div>

              {/* Submit Error Banner */}
              {submitError && (
                <div
                  className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2"
                  data-testid="feedback-submit-error"
                >
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Error saving report</p>
                    <p className="text-rose-200/90 mt-0.5">{submitError}</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#30363d] bg-[#0d1117] shrink-0">
          <button
            type="button"
            data-testid="feedback-modal-cancel-btn"
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-medium text-zinc-400 hover:text-white bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-lg transition-colors cursor-pointer"
          >
            {submitResult ? 'Close' : 'Cancel'}
          </button>

          {!submitResult && (
            <button
              type="button"
              data-testid="feedback-modal-submit-btn"
              onClick={handleSubmit}
              disabled={isSubmitting || isLoadingSnapshot || !!snapshotError}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-lg transition-colors shadow-sm cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving Fixture...</span>
                </>
              ) : (
                <>
                  <FileCode className="w-3.5 h-3.5" />
                  <span>Save Report & Export Fixture</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
