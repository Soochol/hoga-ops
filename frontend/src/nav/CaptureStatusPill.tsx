import { Link } from 'react-router';
import { useCaptureJob } from '../capture/useCaptureJob';

export default function CaptureStatusPill() {
  const { job } = useCaptureJob();
  if (!job) return null;
  if (job.phase !== 'capturing' && job.phase !== 'parsing') return null;

  const label = job.phase === 'capturing' ? 'CAPTURING' : 'PARSING';
  const p = job.progress;
  const stats = p ? `${p.pages_done} pg · ${p.events_seen.toLocaleString()} ev · ~${p.estimate_pct}%` : '…';

  return (
    <Link to="/capture" data-testid="capture-pill"
          className="m-2.5 p-2 block bg-bg-card border rounded
                     hover:bg-bg-input-hover transition-colors">
      <div className="flex justify-between items-center mb-1">
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-accent flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-accent capture-pulse" />
          {label}
        </span>
        <span className="font-mono text-[11px] text-fg tabular-nums">{job.code}</span>
      </div>
      <div className="font-mono text-[10px] text-fg-dim tabular-nums">{stats}</div>
      {p && (
        <div className="h-0.5 bg-bg-input rounded mt-1.5 overflow-hidden">
          <div className="h-full bg-accent" style={{ width: `${p.estimate_pct}%` }} />
        </div>
      )}
    </Link>
  );
}
