import type { QueueItem } from '../api/types';

function formatKstClock(unixMs: number | null): string {
  if (unixMs === null) return '–';
  const d = new Date(unixMs);
  const hh = String(d.getUTCHours() + 9).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function CaptureRowDetail({ item }: { item: QueueItem }) {
  return (
    <div
      data-testid={`queue-row-detail-${item.item_id}`}
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-sm px-md bg-bg-subtle border-b font-normal text-sm font-mono text-fg-dim"
    >
      <span>started_at</span>
      <span className="text-fg tabular-nums">
        {formatKstClock(item.started_at_ms)}
      </span>
      <span>frontier</span>
      <span className="text-fg tabular-nums">
        {formatKstClock(item.progress?.frontier_ms ?? null)}
      </span>
      <span>enqueued_at</span>
      <span className="text-fg tabular-nums">
        {formatKstClock(item.enqueued_at_ms)}
      </span>
      {item.error !== null && (
        <>
          <span className="text-down">error</span>
          <span className="text-down">
            {item.error.code}: {item.error.message}
            {item.error.at_page !== null && item.error.at_page !== undefined ? ` (page ${item.error.at_page})` : ''}
          </span>
        </>
      )}
      {item.result !== null && (
        <>
          <span>result</span>
          <span className="text-fg">
            pages_written={item.result.pages_written} unique_events={item.result.unique_events}
            {item.result.parsed ? ' parsed' : ''}
          </span>
        </>
      )}
    </div>
  );
}
