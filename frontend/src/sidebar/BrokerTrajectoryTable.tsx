import { useMemo } from 'react';
import type { BrokerSeriesEntry, BrokerSeriesPoint } from '../api/types';
import {
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
} from '../live/liveDateTime';
import { brokerDisplayShort } from './brokerDisplayNames';

/** Gap detection threshold (ms). Consecutive points farther apart are
 *  rendered with a dashed segment indicating the broker was outside top-5
 *  between observations. Honest about the brokers parquet's top-5 truncation
 *  rather than forward-fill (see ADR-0023 and the spec's § 4 Data Gaps). */
export const GAP_THRESHOLD_MS = 30_000;
export const BROKER_TRAJECTORY_ROW_LIMIT = 10;

type Props = {
  series: BrokerSeriesEntry[] | null | undefined;
  cursorMs: number | null;
  gapThresholdMs?: number;
};

export default function BrokerTrajectoryTable({ series, cursorMs, gapThresholdMs = GAP_THRESHOLD_MS }: Props) {
  const rows = useMemo(
    () =>
      (series?.slice(0, BROKER_TRAJECTORY_ROW_LIMIT) ?? [])
        .map(clipEntryToRegularSession)
        .filter((entry) => entry.points.length > 0),
    [series],
  );
  // Common time domain across all displayed brokers — keeps cursor marker
  // X positions aligned across rows.
  const dayRange = useMemo(() => {
    if (rows.length === 0) return null;
    let first = Infinity;
    let last = -Infinity;
    for (const e of rows) {
      for (const p of e.points) {
        const date = realMsToYyyymmdd(p.ts_ms);
        const open = regularSessionOpenMs(date);
        const close = regularSessionCloseMs(date);
        if (open < first) first = open;
        if (close > last) last = close;
      }
    }
    return Number.isFinite(first) && Number.isFinite(last) && last > first
      ? { first, last }
      : null;
  }, [rows]);

  if (series === undefined) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        커서 위치 로딩 중…
      </div>
    );
  }
  if (series === null || series.length === 0 || rows.length === 0) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        거래원 정보 없음
      </div>
    );
  }

  return (
    <div className="font-mono text-sm tabular-nums divide-y divide-border-strong">
      {rows.map((entry) => {
        const net = netAtCursor(entry, cursorMs);
        return (
          <div
            key={entry.broker}
            data-testid="broker-row"
            className="grid grid-cols-[60px_1fr_80px] gap-2 px-2.5 py-0.5 items-center"
          >
            <span className="truncate" title={entry.broker}>
              {brokerDisplayShort(entry.broker)}
            </span>
            <Sparkline entry={entry} cursorMs={cursorMs} dayRange={dayRange} gapThresholdMs={gapThresholdMs} />
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

function clipEntryToRegularSession(entry: BrokerSeriesEntry): BrokerSeriesEntry {
  const firstPoint = entry.points[0];
  if (!firstPoint) return entry;
  const date = realMsToYyyymmdd(firstPoint.ts_ms);
  const open = regularSessionOpenMs(date);
  const close = regularSessionCloseMs(date);
  const points = entry.points.filter((p) => p.ts_ms >= open && p.ts_ms <= close);
  return points.length === entry.points.length ? entry : { ...entry, points };
}

/** Pure function. Binary-searches entry.points for the last ts <= cursorMs.
 *  Returns 0 when cursorMs is null or precedes the first observation. */
export function netAtCursor(
  entry: BrokerSeriesEntry,
  cursorMs: number | null,
): number {
  if (cursorMs == null) return 0;
  const pts = entry.points;
  if (pts.length === 0) return 0;
  if (cursorMs < pts[0].ts_ms) return 0;
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
  gapThresholdMs,
}: {
  entry: BrokerSeriesEntry;
  cursorMs: number | null;
  dayRange: { first: number; last: number } | null;
  gapThresholdMs: number;
}) {
  // Width/height in viewBox units — preserveAspectRatio="none" lets CSS scale.
  const W = 60;
  const H = 16;

  const pts = entry.points;
  const geometry = useMemo(() => {
    if (pts.length === 0 || !dayRange) return null;
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
    const segments = buildSegments(pts, gapThresholdMs).map((seg) => ({
      kind: seg.kind,
      points: seg.pts.map((p) => `${toX(p.ts_ms)},${toY(p.net)}`).join(' '),
    }));
    return { tsFirst, tsLast, tSpan, segments };
  }, [dayRange, gapThresholdMs, pts]);

  if (!geometry) {
    return <span className="block w-full h-4" />;
  }

  const stroke =
    entry.dominant_side === 'buy' ? 'var(--price-up)' : 'var(--price-down)';

  // Cursor marker: only visible when cursorMs is inside the day's range.
  const { tsFirst, tsLast, tSpan, segments } = geometry;
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
        if (seg.kind === 'solid') {
          return (
            <polyline
              key={`s${i}`}
              fill="none"
              stroke={stroke}
              strokeWidth={1.2}
              points={seg.points}
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
            points={seg.points}
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
