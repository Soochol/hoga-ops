import type { CaptureError, QueueItem, UpstreamCode, ViolationWire } from '../api/types';
import { captureFinishedHints } from '../api/upstream-hints';
import { TimingPanel } from './timing/TimingPanel';
import { useCaptureTimings } from './timing/useCaptureTimings';

function ErrorBlock({ error }: { error: CaptureError }) {
  const knownHint = (error.code in captureFinishedHints)
    ? captureFinishedHints[error.code as UpstreamCode]
    : null;
  return (
    <>
      <div>{knownHint ?? <>{error.code}: {error.message}{error.at_page != null ? ` (page ${error.at_page})` : ''}</>}</div>
      {knownHint && (
        <div style={{ fontSize: 'var(--font-size-xs, 0.85em)', opacity: 0.8, marginTop: 4 }}>
          {error.message}{error.at_page != null ? ` (page ${error.at_page})` : ''}
        </div>
      )}
    </>
  );
}

function formatKstClock(unixMs: number | null): string {
  if (unixMs === null) return '–';
  const d = new Date(unixMs);
  const hh = String(d.getUTCHours() + 9).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function CaptureRowDetail({ item }: { item: QueueItem }) {
  const timingId = `${item.code}:${item.date}`;
  const hasTiming = useCaptureTimings((s) => Boolean(s.timings[timingId]));
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
          <span className="text-error">error</span>
          <span className="text-error">
            <ErrorBlock error={item.error} />
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
          {item.result.abort_reason !== null && (
            <>
              <span className="text-warn">abort_reason</span>
              <span className="text-warn">
                {abortReasonHint(item.result.abort_reason)}
              </span>
            </>
          )}
        </>
      )}
      {item.warnings != null && item.warnings.length > 0 && (
        <>
          <span className="text-warn">warnings</span>
          <span className="text-warn">
            <WarningsBlock warnings={item.warnings} />
          </span>
        </>
      )}
      {hasTiming && (
        <div
          className="mt-sm pt-xs"
          style={{ borderTop: '1px solid var(--border)', gridColumn: '1 / -1' }}
        >
          <TimingPanel id={timingId} />
        </div>
      )}
    </div>
  );
}

function WarningsBlock({ warnings }: { warnings: ViolationWire[] }) {
  return (
    <ul className="list-none p-0 m-0">
      {warnings.map((w, i) => (
        <li key={`${w.invariant_id}:${i}`}>
          {warningHint(w)}
        </li>
      ))}
    </ul>
  );
}

function warningHint(w: ViolationWire): string {
  // Surface the invariant_id so operators can correlate with archived
  // meta.json. Severity is implied by the warn-tinted block; we leave it
  // out of the line to avoid noise.
  if (w.invariant_id === 'series.cum_vol_monotonic') {
    return `누적 거래량이 한 차례 역행했습니다(업스트림 보정). 데이터는 그대로 저장됨. (${w.message})`;
  }
  return `${w.invariant_id}: ${w.message}`;
}

function abortReasonHint(reason: string): string {
  // Hogaplay's response froze mid-stream; the captured parquet covers only
  // the data up to the freeze. Operator should retry the date.
  if (reason === 'stagnation_abort') {
    return 'hogaplay 응답 동결로 캡처가 중단되었습니다. 재시도하세요.';
  }
  return reason;
}
