import { useMemo } from 'react';
import type { BrokerSeriesEntry, BrokerSeriesPoint } from '../api/types';
import {
  realMsToYyyymmdd,
  regularSessionCloseMs,
  regularSessionOpenMs,
} from '../live/liveDateTime';
import { brokerDisplayShort } from './brokerDisplayNames';
import { SidebarState } from './SidebarSurface';

/** Gap detection threshold (ms). Consecutive points farther apart are
 *  rendered with a dashed segment indicating the broker was outside top-5
 *  between observations. Honest about the brokers parquet's top-5 truncation
 *  rather than forward-fill (see ADR-0023 and the spec's § 4 Data Gaps). */
export const GAP_THRESHOLD_MS = 30_000;

type Props = {
  series: BrokerSeriesEntry[] | null | undefined;
  cursorMs: number | null;
  gapThresholdMs?: number;
};

export default function BrokerTrajectoryTable({ series, cursorMs, gapThresholdMs = GAP_THRESHOLD_MS }: Props) {
  const rows = useMemo(
    () =>
      (series ?? [])
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
      <SidebarState>
        커서 위치 로딩 중…
      </SidebarState>
    );
  }
  if (series === null || series.length === 0 || rows.length === 0) {
    return (
      <SidebarState>
        거래원 정보 없음
      </SidebarState>
    );
  }

  // 규모 바 분모: 커서 시점 |순매수| 최대값. 행간 상대 규모 비교용(depth bar 문법).
  const nets = rows.map((entry) => netAtCursor(entry, cursorMs));
  const maxAbsNet = nets.reduce<number>((acc, net) => Math.max(acc, Math.abs(net ?? 0)), 0);

  return (
    <div className="font-mono text-sm tabular-nums divide-y divide-border-strong">
      {rows.map((entry, rowIndex) => {
        const net = nets[rowIndex];
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
            {net == null ? (
              // 커서가 첫 관측 이전(아직 등장 전) — 진짜 0과 구분해 표기한다.
              <span data-testid="broker-net-preobs" className="text-fg-dimmer text-right">—</span>
            ) : (
              <span className="relative block text-right">
                {maxAbsNet > 0 && net !== 0 && (
                  <span
                    aria-hidden
                    data-testid="broker-net-bar"
                    className="absolute inset-y-0 right-0 rounded-[1px]"
                    style={{
                      width: `${(Math.abs(net) / maxAbsNet) * 100}%`,
                      background: net > 0 ? 'var(--tint-price-up)' : 'var(--tint-price-down)',
                    }}
                  />
                )}
                <span
                  className={`relative ${
                    net > 0 ? 'text-price-up' : net < 0 ? 'text-price-down' : 'text-fg-dimmer'
                  }`}
                >
                  {net > 0 ? '+' : ''}
                  {net.toLocaleString('ko-KR')}
                </span>
              </span>
            )}
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
 *  Returns null when cursorMs is null or precedes the first observation —
 *  "아직 등장 전"을 진짜 순매수 0과 구분하기 위해서다(표시는 —). */
export function netAtCursor(
  entry: BrokerSeriesEntry,
  cursorMs: number | null,
): number | null {
  if (cursorMs == null) return null;
  const pts = entry.points;
  if (pts.length === 0) return null;
  if (cursorMs < pts[0].ts_ms) return null;
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
    const zeroY = toY(0);
    const segments = buildSegments(pts, gapThresholdMs).map((seg) => {
      const coords = seg.pts.map((p) => ({ x: toX(p.ts_ms), y: toY(p.net) }));
      const path = coords.map((c) => `${c.x},${c.y}`).join(' ');
      // 0선까지 내려 닫은 면적 폴리곤. 실선 구간에만 채운다 — 점선(미관측)
      // 구간을 칠하면 top-5 밖이라 모르는 값을 안다고 주장하게 된다(ADR-0023).
      const area =
        seg.kind === 'solid' && coords.length >= 2
          ? `${coords[0].x},${zeroY} ${path} ${coords[coords.length - 1].x},${zeroY}`
          : null;
      return { kind: seg.kind, points: path, area };
    });
    return { tsFirst, tsLast, tSpan, segments, zeroY, toY };
  }, [dayRange, gapThresholdMs, pts]);

  if (!geometry) {
    return <span className="block w-full h-4" />;
  }

  const stroke =
    entry.dominant_side === 'buy' ? 'var(--price-up)' : 'var(--price-down)';
  // 면적은 방향 인지용 — 규모는 우측 숫자·규모 바가 담당한다. Y 도메인이 행별
  // 정규화라 진한 면적은 소형 거래원을 대형처럼 보이게 하므로 tint(≈10% alpha).
  const fill =
    entry.dominant_side === 'buy' ? 'var(--tint-price-up)' : 'var(--tint-price-down)';

  // Cursor marker: only visible when cursorMs is inside the day's range.
  const { tsFirst, tsLast, tSpan, segments, zeroY, toY } = geometry;
  const showCursor =
    cursorMs != null && cursorMs >= tsFirst && cursorMs <= tsLast;
  const cursorX = showCursor ? ((cursorMs! - tsFirst) / tSpan) * W : 0;
  // 커서 교차점 도트: 궤적이 실제로 존재하는 구간(첫~마지막 관측)에서만.
  // preserveAspectRatio=none 아래 <circle>은 타원으로 찌그러지므로 svg 밖
  // div 오버레이로 그린다(매물대 close-dot과 동일 기법).
  const dotNet = showCursor ? netOnDrawnLineAt(pts, cursorMs!) : null;
  const dotTopPct = dotNet != null ? (toY(dotNet) / H) * 100 : null;

  return (
    <span className="relative block h-4 w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-4 block"
      >
        <line
          data-testid="zero-baseline"
          x1={0}
          x2={W}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--grid)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {segments.map((seg, i) =>
          seg.area ? (
            <polygon
              key={`a${i}`}
              data-testid="trajectory-area"
              fill={fill}
              stroke="none"
              points={seg.area}
            />
          ) : null,
        )}
        {segments.map((seg, i) => {
          if (seg.kind === 'solid') {
            return (
              <polyline
                key={`s${i}`}
                fill="none"
                stroke={stroke}
                strokeWidth={1.2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
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
              // non-scaling-stroke 아래 dash 는 화면 px 로 해석된다. 기존
              // 1.5 유저단위(≈5px)와 같은 밀도를 유지하려면 값을 키워야 —
              // 그대로 두면 점선이 실선처럼 뭉쳐 미관측 구간 신호가 죽는다.
              strokeDasharray="3,3"
              vectorEffect="non-scaling-stroke"
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
            strokeWidth={1}
            strokeDasharray="2,2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {dotTopPct != null && (
        <span
          data-testid="cursor-value-dot"
          className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${(cursorX / W) * 100}%`,
            top: `${dotTopPct}%`,
            background: stroke,
            border: '1px solid var(--bg-card)',
          }}
        />
      )}
    </span>
  );
}

/** 커서 시각에서 "그려진 라인" 위의 net 값(선형 보간). netAtCursor(계단
 *  의미론, 표시 숫자용)와 달리 도트를 시각적 궤적 위에 정확히 앉히기 위한
 *  기하용이다. 궤적 범위 밖이면 null. */
function netOnDrawnLineAt(pts: BrokerSeriesPoint[], cursorMs: number): number | null {
  if (pts.length === 0) return null;
  if (cursorMs < pts[0].ts_ms || cursorMs > pts[pts.length - 1].ts_ms) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].ts_ms <= cursorMs) lo = mid;
    else hi = mid - 1;
  }
  const a = pts[lo];
  const b = pts[lo + 1];
  if (!b || a.ts_ms === cursorMs) return a.net;
  const t = (cursorMs - a.ts_ms) / (b.ts_ms - a.ts_ms || 1);
  return a.net + (b.net - a.net) * t;
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
