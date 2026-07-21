import type { CaptureError, CaptureProgress, QueueItem, UpstreamCode, ViolationWire } from '../api/types';
import { captureFinishedHints } from '../api/upstream-hints';
import { unixMsToKSTClock } from '../util/time';
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

// Delegates to the canonical KST formatter (util/time.ts), which shifts the
// epoch by +9h before reading UTC fields. The previous inline `getUTCHours()
// + 9` overflowed past 23 for UTC hours >= 15 (KST 00:00–08:59 rendered as
// "24:.."–"32:..").
function formatKstClock(unixMs: number | null): string {
  return unixMs === null ? '–' : unixMsToKSTClock(unixMs);
}

// "8.3 pages/s · http p50 45ms · 429 ×3" — upstream-health line for running
// rows. pages/s comes from cumulative pages/elapsed; p50 & 429 mirror the
// backend telemetry (see CaptureProgress in api/types.ts). Segments render
// only when their datum exists so legacy payloads degrade to pages/s alone.
function speedLine(progress: CaptureProgress): string {
  const parts = [`${(progress.pages_done / (progress.elapsed_ms / 1000)).toFixed(1)} pages/s`];
  if (progress.recent_http_p50_ms != null) {
    parts.push(`http p50 ${Math.round(progress.recent_http_p50_ms)}ms`);
  }
  if ((progress.throttled_pages ?? 0) > 0) {
    parts.push(`429 ×${progress.throttled_pages}`);
  }
  return parts.join(' · ');
}

export function CaptureRowDetail({ item }: { item: QueueItem }) {
  const timingId = `${item.code}:${item.date}`;
  const hasTiming = useCaptureTimings((s) => Boolean(s.timings[timingId]));
  return (
    <div
      data-testid={`queue-row-detail-${item.item_id}`}
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-sm px-md bg-bg-subtle border-b font-normal text-sm font-data text-fg-dim"
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
      {item.progress != null && item.progress.elapsed_ms > 0 && (
        <>
          <span>speed</span>
          <span className="text-fg tabular-nums" data-testid="queue-row-detail-speed">
            {speedLine(item.progress)}
          </span>
        </>
      )}
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
