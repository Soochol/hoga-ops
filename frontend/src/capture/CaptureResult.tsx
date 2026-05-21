import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { CaptureJob } from '../api/types';
import { formatElapsed } from '../util/time';

interface Props {
  job: CaptureJob;
  onDismiss: () => void;
  onResume: (job: CaptureJob) => void;
}

const PRIMARY_BTN = 'bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded';
const SECONDARY_BTN = 'bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded';

export function CaptureResult({ job, onDismiss, onResume }: Props) {
  const navigate = useNavigate();
  const elapsed = job.progress ? formatElapsed(job.progress.elapsed_ms) : '?';

  if (job.phase === 'done' && job.result) {
    const r = job.result;
    return (
      <Shell job={job} elapsed={elapsed} kind="done" onDismiss={onDismiss}
             actions={
               <>
                 {/* Match the Replay page's URL schema (state/url.ts):
                     `?tabs=CODE:fromDate:toDate&active=N`. Use the same
                     Stock-Date as both fromDate and toDate so the new
                     capture lands as a single-day tab. */}
                 <button
                   onClick={() => navigate(`/replay?tabs=${job.code}:${job.date}:${job.date}&active=0`)}
                   className={PRIMARY_BTN}
                 >
                   Open in Replay →
                 </button>
                 <button onClick={() => navigate('/inventory')} className={SECONDARY_BTN}>
                   View in Inventory
                 </button>
               </>
             }>
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="Pages" value={r.pages_written.toString()} />
          <Stat label="Events" value={r.unique_events.toLocaleString()} />
          <Stat label="Parsed" value={r.parsed ? 'Y' : 'N'} highlight={r.parsed ? 'up' : undefined} />
          <Stat label="Raw" value="✓" />
        </div>
      </Shell>
    );
  }

  if (job.phase === 'failed' && job.error) {
    return (
      <Shell job={job} elapsed={elapsed} kind="failed" onDismiss={onDismiss}
             actions={<button onClick={() => onResume(job)} className={PRIMARY_BTN}>Retry with Resume</button>}>
        <div className="bg-[rgba(244,63,94,0.08)] border border-[rgba(244,63,94,0.3)] rounded p-3 mb-3">
          <div className="text-[12px] font-semibold text-[--down] mb-1.5 font-mono">{job.error.code}</div>
          <div className="text-[11.5px] text-fg-dim leading-relaxed">{job.error.message}</div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell job={job} elapsed={elapsed} kind="cancelled" onDismiss={onDismiss}
           actions={
             <button onClick={() => onResume(job)} className={PRIMARY_BTN}>
               Resume from page {job.progress?.pages_done ?? '?'}
             </button>
           }>
      <div className="text-[12px] text-fg-dim mb-3">
        Cancelled at page {job.progress?.pages_done ?? '?'}. Raw pages preserved on disk; click Resume to continue.
      </div>
    </Shell>
  );
}

type Kind = 'done' | 'failed' | 'cancelled';

function Shell({
  job, elapsed, kind, actions, onDismiss, children,
}: {
  job: CaptureJob; elapsed: string; kind: Kind;
  actions: ReactNode; onDismiss: () => void; children: ReactNode;
}) {
  return (
    <div className="bg-bg-card border rounded p-3.5">
      <Header job={job} elapsed={elapsed} kind={kind} />
      {children}
      <div className="flex gap-2">
        {actions}
        <div className="flex-1" />
        <button onClick={onDismiss} className={SECONDARY_BTN}>Dismiss</button>
      </div>
    </div>
  );
}

function Header({ job, elapsed, kind }: { job: CaptureJob; elapsed: string; kind: Kind }) {
  const tint = {
    done: ['bg-[rgba(34,197,94,0.10)]', 'text-[--up]', '✓'],
    failed: ['bg-[rgba(244,63,94,0.10)]', 'text-[--down]', '×'],
    cancelled: ['bg-[rgba(148,163,184,0.12)]', 'text-fg-dim', '—'],
  }[kind];
  return (
    <div className="flex justify-between items-center mb-3.5">
      <div className="flex items-center gap-2">
        <span className={`w-3.5 h-3.5 rounded-full grid place-items-center text-bg text-[9px] font-bold ${tint[0]} ${tint[1]}`}>
          {tint[2]}
        </span>
        <span className="font-mono text-[13px] text-fg">{job.code} / {job.date}</span>
        <span className={`${tint[0]} ${tint[1]} text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded`}>
          {kind}
        </span>
      </div>
      <span className="font-mono text-[11px] text-fg-dim">finished in {elapsed}</span>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: 'up' }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-fg-dim mb-1">{label}</div>
      <div className={`font-mono text-[22px] font-medium tabular-nums ${highlight === 'up' ? 'text-[--up]' : 'text-fg'}`}>
        {value}
      </div>
    </div>
  );
}
