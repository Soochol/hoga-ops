import { useNavigate } from 'react-router';
import type { CaptureJob } from '../api/types';
import { formatElapsed } from '../util/time';

interface Props {
  job: CaptureJob;
  onDismiss: () => void;
  onResume: (job: CaptureJob) => void;
}

export function CaptureResult({ job, onDismiss, onResume }: Props) {
  const navigate = useNavigate();
  const elapsed = job.progress ? formatElapsed(job.progress.elapsed_ms) : '?';

  if (job.phase === 'done' && job.result) {
    return (
      <div className="bg-bg-card border rounded p-3.5">
        <Header job={job} elapsed={elapsed} kind="done" />
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="Pages" value={job.result.pages_written.toString()} />
          <Stat label="Events" value={job.result.unique_events.toLocaleString()} />
          <Stat label="Parsed" value={job.result.parsed ? 'Y' : 'N'} highlight={job.result.parsed ? 'up' : undefined} />
          <Stat label="Raw" value="✓" />
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate(`/replay?code=${job.code}&date=${job.date}`)}
                  className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded">
            Open in Replay →
          </button>
          <button onClick={() => navigate('/inventory')}
                  className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
            View in Inventory
          </button>
          <div className="flex-1" />
          <button onClick={onDismiss}
                  className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (job.phase === 'failed' && job.error) {
    return (
      <div className="bg-bg-card border rounded p-3.5">
        <Header job={job} elapsed={elapsed} kind="failed" />
        <div className="bg-[rgba(244,63,94,0.08)] border border-[rgba(244,63,94,0.3)] rounded p-3 mb-3">
          <div className="text-[12px] font-semibold text-[--down] mb-1.5 font-mono">
            {job.error.code}
          </div>
          <div className="text-[11.5px] text-fg-dim leading-relaxed">{job.error.message}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => onResume(job)}
                  className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded">
            Retry with Resume
          </button>
          <div className="flex-1" />
          <button onClick={onDismiss}
                  className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-bg-card border rounded p-3.5">
      <Header job={job} elapsed={elapsed} kind="cancelled" />
      <div className="text-[12px] text-fg-dim mb-3">
        Cancelled at page {job.progress?.pages_done ?? '?'}. Raw pages preserved on disk; click Resume to continue.
      </div>
      <div className="flex gap-2">
        <button onClick={() => onResume(job)}
                className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded">
          Resume from page {job.progress?.pages_done ?? '?'}
        </button>
        <div className="flex-1" />
        <button onClick={onDismiss}
                className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function Header({ job, elapsed, kind }: { job: CaptureJob; elapsed: string; kind: 'done' | 'failed' | 'cancelled' }) {
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
      <div className={`font-mono text-[22px] font-medium tabular-nums ${
        highlight === 'up' ? 'text-[--up]' : 'text-fg'
      }`}>{value}</div>
    </div>
  );
}
