import { useMemo } from 'react';
import type { BrokerSeriesEntry, BrokerSeriesPoint } from '../api/types';

/** Gap detection threshold (ms). Consecutive points farther apart are
 *  rendered with a dashed segment indicating the broker was outside top-5
 *  between observations. Honest about the brokers parquet's top-5 truncation
 *  rather than forward-fill (see ADR-0023 and the spec's § 4 Data Gaps). */
export const GAP_THRESHOLD_MS = 30_000;

type Props = {
  series: BrokerSeriesEntry[] | null | undefined;
  cursorMs: number | null;
};

export default function BrokerTrajectoryTable({ series, cursorMs }: Props) {
  // Common time domain across all displayed brokers — keeps cursor marker
  // X positions aligned across rows.
  const dayRange = useMemo(() => {
    if (!series || series.length === 0) return null;
    let first = Infinity;
    let last = -Infinity;
    for (const e of series) {
      for (const p of e.points) {
        if (p.ts_ms < first) first = p.ts_ms;
        if (p.ts_ms > last) last = p.ts_ms;
      }
    }
    return Number.isFinite(first) && Number.isFinite(last) && last > first
      ? { first, last }
      : null;
  }, [series]);

  if (series === undefined) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        커서 위치 로딩 중…
      </div>
    );
  }
  if (series === null || series.length === 0) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        거래원 정보 없음
      </div>
    );
  }

  const rows = series.slice(0, 10);
  return (
    <div className="font-mono text-sm tabular-nums divide-y divide-grid">
      {rows.map((entry) => {
        const net = netAtCursor(entry, cursorMs);
        return (
          <div
            key={entry.broker}
            data-testid="broker-row"
            className="grid grid-cols-[60px_1fr_80px] gap-2 px-2.5 py-0.5 items-center"
          >
            <span className="truncate">{trunc(entry.broker)}</span>
            <Sparkline entry={entry} cursorMs={cursorMs} dayRange={dayRange} />
            <span
              className={
                net > 0
                  ? 'text-price-up text-right'
                  : net < 0
                    ? 'text-price-down text-right'
                    : 'text-fg-dimmer text-right'
              }
            >
              {net > 0 ? '+' : ''}
              {net.toLocaleString('ko-KR')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function trunc(name: string): string {
  // Korean broker names are typically already short. Cap at 4 characters
  // (carry-over from the prior BrokerNetTable convention).
  return name.length > 4 ? name.slice(0, 4) : name;
}

/** Pure function. Binary-searches entry.points for the last ts <= cursorMs.
 *  Returns 0 when cursorMs is null or precedes the broker's first observation. */
export function netAtCursor(
  entry: BrokerSeriesEntry,
  cursorMs: number | null,
): number {
  if (cursorMs == null) return 0;
  const pts = entry.points;
  if (pts.length === 0 || cursorMs < pts[0].ts_ms) return 0;
  // Binary search for the rightmost point with ts_ms <= cursorMs.
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].ts_ms <= cursorMs) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo].net;
}

function Sparkline({
  entry,
  cursorMs,
  dayRange,
}: {
  entry: BrokerSeriesEntry;
  cursorMs: number | null;
  dayRange: { first: number; last: number } | null;
}) {
  // Width/height in viewBox units — preserveAspectRatio="none" lets CSS scale.
  const W = 60;
  const H = 16;

  const pts = entry.points;
  if (pts.length === 0 || !dayRange) {
    return <span className="block w-full h-4" />;
  }

  const { first: tsFirst, last: tsLast } = dayRange;
  const tSpan = tsLast - tsFirst || 1;

  // Per-row Y domain: include 0 so the line stays visible whether the
  // trajectory is purely positive (buyer), purely negative (seller), or
  // straddles zero (rare mixed-side broker).
  let netMin = 0;
  let netMax = 0;
  for (const p of pts) {
    if (p.net < netMin) netMin = p.net;
    if (p.net > netMax) netMax = p.net;
  }
  const nSpan = netMax - netMin || 1;

  const toX = (t: number) => ((t - tsFirst) / tSpan) * W;
  const toY = (n: number) => H - ((n - netMin) / nSpan) * H;

  const stroke =
    entry.dominant_side === 'buy' ? 'var(--price-up)' : 'var(--price-down)';

  // Split the polyline into solid vs dashed segments based on
  // GAP_THRESHOLD_MS. We emit one <polyline> per contiguous run, with
  // dashed runs styled differently. A "run" is a sequence of consecutive
  // points joined by gaps <= threshold.
  const segments = buildSegments(pts, GAP_THRESHOLD_MS);

  // Cursor marker: only visible when cursorMs is inside the day's range.
  const showCursor =
    cursorMs != null && cursorMs >= tsFirst && cursorMs <= tsLast;
  const cursorX = showCursor ? ((cursorMs! - tsFirst) / tSpan) * W : 0;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-4 block"
    >
      {segments.map((seg, i) => {
        const points = seg.pts.map((p) => `${toX(p.ts_ms)},${toY(p.net)}`).join(' ');
        if (seg.kind === 'solid') {
          return (
            <polyline
              key={`s${i}`}
              fill="none"
              stroke={stroke}
              strokeWidth={1.2}
              points={points}
            />
          );
        }
        return (
          <polyline
            key={`d${i}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.2}
            strokeDasharray="1.5,1.5"
            opacity={0.4}
            points={points}
          />
        );
      })}
      {showCursor && (
        <line
          data-testid="cursor-marker"
          x1={cursorX}
          x2={cursorX}
          y1={0}
          y2={H}
          stroke="var(--accent)"
          strokeWidth={0.6}
          strokeDasharray="1,1"
        />
      )}
    </svg>
  );
}

type Segment =
  | { kind: 'solid'; pts: BrokerSeriesPoint[] }
  | { kind: 'dashed'; pts: BrokerSeriesPoint[] };   // always exactly 2 points

/** Split consecutive points into solid runs and 2-point dashed bridges.
 *  A gap > threshold between p[i] and p[i+1] flushes the current solid run
 *  (if non-empty) and emits a 2-point dashed segment from p[i] to p[i+1];
 *  the next solid run starts at p[i+1]. */
function buildSegments(
  pts: BrokerSeriesPoint[],
  thresholdMs: number,
): Segment[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ kind: 'solid', pts: [pts[0]] }];

  const out: Segment[] = [];
  let run: BrokerSeriesPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].ts_ms - pts[i - 1].ts_ms;
    if (gap <= thresholdMs) {
      run.push(pts[i]);
    } else {
      // Flush current solid run.
      if (run.length >= 1) out.push({ kind: 'solid', pts: run });
      // Dashed bridge from last-of-run to pts[i].
      out.push({ kind: 'dashed', pts: [pts[i - 1], pts[i]] });
      // New solid run begins at pts[i].
      run = [pts[i]];
    }
  }
  if (run.length >= 1) out.push({ kind: 'solid', pts: run });
  return out;
}
