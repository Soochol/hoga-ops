import { useEffect, useRef, useState } from 'react';
import type { CaptureJob } from '../api/types';
import { formatElapsed, unixMsToKSTClock } from '../util/time';
import { CaptureLog, type LogLine } from './CaptureLog';

interface Props {
  job: CaptureJob;
  onCancel: () => void;
}

export function CaptureProgress({ job, onCancel }: Props) {
  const [confirming, setConfirming] = useState(false);
  const logRef = useRef<LogLine[]>([]);
  const lastPageRef = useRef(0);
  const lastEventsSeenRef = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    if (!job.progress) return;
    if (job.progress.pages_done !== lastPageRef.current) {
      // events_added = delta of cumulative events_seen across pages.
      // Bug guard: events_seen is cumulative; the previous line's count is
      // stored in lastEventsSeenRef, not events_added (which is itself a delta).
      const added = Math.max(0, job.progress.events_seen - lastEventsSeenRef.current);
      logRef.current = [
        { page: job.progress.pages_done, frontier_ms: job.progress.frontier_ms,
          events_added: added },
        ...logRef.current,
      ].slice(0, 10);
      lastPageRef.current = job.progress.pages_done;
      lastEventsSeenRef.current = job.progress.events_seen;
      force((n) => n + 1);
    }
  }, [job.progress]);

  const p = job.progress;
  // Parent Capture.tsx only mounts CaptureProgress while phase ∈ {capturing, parsing}.
  // Reading the ternary with `parsing` as the explicit branch makes the default
  // fall on the correct side if a future call site mounts us with a different
  // phase (terminal states display "CAPTURING" rather than "PARSING").
  const phasePill = job.phase === 'parsing' ? 'PARSING' : 'CAPTURING';

  return (
    <div className="bg-bg-card border rounded p-3.5">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[13px] text-fg">{job.code} / {job.date}</span>
          <span className="bg-[rgba(20,184,166,0.12)] text-accent text-[10.5px] font-semibold
                          uppercase tracking-wider px-2 py-0.5 rounded"
                data-testid="capture-phase">{phasePill}</span>
        </div>
        <span className="font-mono text-[11px] text-fg-dim">
          {p ? formatElapsed(p.elapsed_ms) : '0:00'} elapsed
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3.5">
        <Stat label="Pages" value={p ? p.pages_done.toString() : '0'} />
        <Stat label="Events" value={p ? p.events_seen.toLocaleString() : '0'} />
        <Stat label="Frontier" value={p ? unixMsToKSTClock(p.frontier_ms) : '—'} />
      </div>

      <div className="flex justify-between text-[10px] uppercase tracking-wider
                      text-fg-dimmer font-semibold mb-1.5">
        <span>progress (est.)</span>
        <span className="font-mono text-[11px] text-fg-dim normal-case tracking-normal">
          ~{p?.estimate_pct ?? 0}%
        </span>
      </div>
      <div className="h-1 bg-bg-input rounded overflow-hidden mb-3.5">
        <div className="h-full bg-accent transition-[width] duration-300"
             style={{ width: `${p?.estimate_pct ?? 0}%` }} />
      </div>

      <div className="text-[10px] uppercase tracking-wider text-fg-dimmer font-semibold mb-1.5">
        Live log
      </div>
      <CaptureLog lines={logRef.current} />

      <div className="mt-3 text-right">
        {confirming ? (
          <span className="text-[12px] text-fg-dim">
            Sure? <button onClick={onCancel} className="text-[--down] hover:underline">Cancel capture</button>
            {' · '}
            <button onClick={() => setConfirming(false)} className="text-fg-dim hover:underline">Keep going</button>
          </span>
        ) : (
          <button onClick={() => setConfirming(true)}
                  className="text-[12px] text-fg-dim hover:text-fg">Cancel</button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-fg-dim mb-1">{label}</div>
      <div className="font-mono text-[22px] font-medium text-fg tabular-nums">{value}</div>
    </div>
  );
}
