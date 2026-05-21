import { unixMsToKSTClock } from '../util/time';

export interface LogLine {
  page: number;
  frontier_ms: number;
  events_added: number;
}

export function CaptureLog({ lines }: { lines: LogLine[] }) {
  return (
    <div className="bg-bg-subtle border rounded px-2 py-1.5 max-h-[120px] overflow-hidden">
      {lines.length === 0 && (
        <div className="text-[11px] text-fg-dimmer font-mono">waiting for first page…</div>
      )}
      {lines.map((l, i) => (
        <div key={i} className="font-mono text-[11px] text-fg-dim py-0.5">
          <span className="text-fg">page {l.page}</span>
          {' · '}t={unixMsToKSTClock(l.frontier_ms)}
          {' · '}+{l.events_added.toLocaleString()} events
        </div>
      ))}
    </div>
  );
}
