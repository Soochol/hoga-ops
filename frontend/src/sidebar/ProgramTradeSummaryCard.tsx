import { useMemo } from 'react';
import type { ProgramTradePoint, ProgramTradeSeries } from '../api/types';
import { realMsToYyyymmdd } from '../live/liveDateTime';
import { formatKoreanInt, formatKoreanWonEok } from '../util/koreanNumber';
import { SidebarState } from './SidebarSurface';

/** 스파크라인 점선(관측 공백) 판정 임계. 수집 주기(program_trade_collector
 *  30초 drain)의 3배 — 이보다 벌어진 이웃 점 사이는 실측 없이 잇는
 *  구간이므로 점선 브리지로 그린다(브로커 Sparkline 과 같은 규칙).
 *  point.gap_risk 를 쓰지 않는 이유: 현재 백엔드 gap 판정이 WS 30초
 *  드레인 체제에서 매 드레인을 갭으로 오탐해(장중 전 점 true) 신호가 없다. */
export const PROGRAM_SPARK_GAP_THRESHOLD_MS = 90_000;

type Props = {
  series?: ProgramTradeSeries | null;
  cursorMs?: number | null;
};

export default function ProgramTradeSummaryCard({ series, cursorMs = null }: Props) {
  const points = series?.points ?? [];
  const point = pickProgramTradePoint(points, cursorMs);

  if (!point) {
    return (
      <SidebarState className="min-h-[88px] px-3 py-4">
        프로그램 순매수 데이터 없음
      </SidebarState>
    );
  }

  const amountClass = signedClass(point.net_amount);
  const qtyClass = signedClass(point.net_qty);

  return (
    <div className="flex h-full min-h-[96px] flex-col px-3 py-2 font-data text-xs">
      <div className="flex items-center justify-between gap-2 text-fg-dimmer">
        <span>누적 순매수</span>
        <span>{formatTime(point.t)}</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 pt-2 tabular-nums">
        <span className="text-fg-dimmer">금액</span>
        <span className={`text-right text-sm font-semibold ${amountClass}`}>
          {formatSignedAmount(point.net_amount)}
        </span>
        <span className="text-fg-dimmer">수량</span>
        <span className={`text-right ${qtyClass}`}>{formatSigned(point.net_qty)}</span>
      </div>
      <ProgramTradeSparkline points={points} anchorT={point.t} cursorMs={cursorMs} />
      {point.gap_risk && (
        <div className="pt-1 text-[11px] text-fg-dimmer">
          일부 구간 보간
        </div>
      )}
    </div>
  );
}

/** 카드 하단 금액(net_amount) 누적 스파크라인. 메인 차트의 '프로그램 순매수'
 *  pane(projectors/programTrade.ts)과 같은 데이터·같은 색(--accent).
 *  누적 순매수는 일별로 리셋되는데 병합 번들은 여러 날을 담을 수 있으므로,
 *  카드 숫자가 가리키는 point(anchorT)와 같은 KST 날짜만 잘라 그린다. */
function ProgramTradeSparkline({
  points,
  anchorT,
  cursorMs,
}: {
  points: readonly ProgramTradePoint[];
  anchorT: number;
  cursorMs: number | null;
}) {
  // viewBox 단위 — preserveAspectRatio="none" 으로 CSS 크기에 맞춰 늘어난다.
  const W = 100;
  const H = 32;

  const drawable = useMemo(() => {
    const day = realMsToYyyymmdd(anchorT);
    return points
      .filter(
        (p): p is ProgramTradePoint & { net_amount: number } =>
          p.net_amount !== null && realMsToYyyymmdd(p.t) === day,
      )
      .map((p) => ({ t: p.t, v: p.net_amount }));
  }, [points, anchorT]);

  const geometry = useMemo(() => {
    if (drawable.length < 2) return null;
    const tFirst = drawable[0].t;
    const tLast = drawable[drawable.length - 1].t;
    const tSpan = tLast - tFirst || 1;
    // Y 도메인은 0을 항상 포함 — 순매수가 양·음 어느 쪽에 있어도 0 기준선
    // 대비 위치가 보이도록 (브로커 Sparkline 과 같은 규칙).
    let vMin = 0;
    let vMax = 0;
    for (const p of drawable) {
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }
    const vSpan = vMax - vMin || 1;
    const toX = (t: number) => ((t - tFirst) / tSpan) * W;
    const toY = (v: number) => H - ((v - vMin) / vSpan) * H;
    const segments = buildTimeGapSegments(drawable, PROGRAM_SPARK_GAP_THRESHOLD_MS).map((seg) => ({
      kind: seg.kind,
      points: seg.pts.map((p) => `${toX(p.t)},${toY(p.v)}`).join(' '),
    }));
    const zeroY = toY(0);
    return { tFirst, tLast, tSpan, segments, zeroY, toY, vMin, vMax };
  }, [drawable]);

  if (!geometry) {
    return <span className="block min-h-[48px] flex-1 pt-2" />;
  }

  const { tFirst, tLast, tSpan, segments, zeroY, toY, vMin, vMax } = geometry;
  const showCursor = cursorMs != null && cursorMs >= tFirst && cursorMs <= tLast;
  const cursorX = showCursor ? ((cursorMs! - tFirst) / tSpan) * W : 0;
  // 커서 교차점 도트: preserveAspectRatio=none 아래 <circle>은 타원으로
  // 찌그러지므로 svg 밖 div 오버레이로 그린다(브로커 Sparkline 과 동일 기법).
  const dotValue = showCursor ? amountOnDrawnLineAt(drawable, cursorMs!) : null;
  const dotTopPct = dotValue != null ? (toY(dotValue) / H) * 100 : null;

  const zeroPct = (zeroY / H) * 100;
  // 0선 라벨은 도메인 내부(양·음 교차일)일 때만 따로 단다 — 단일 부호 날은
  // 상·하한 라벨 중 하나가 이미 "0억"이라 중복이다. 상·하한 라벨이 각각
  // 플롯 높이의 ~20%를 점유하므로 겹치지 않는 중앙대에서만 그린다.
  const showZeroLabel = vMin < 0 && vMax > 0 && zeroPct > 30 && zeroPct < 70;

  return (
    <div className="mt-2 flex min-h-[48px] flex-1 gap-1.5">
      <span data-testid="program-sparkline" className="relative block flex-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-full w-full"
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
          {segments.map((seg, i) => (
            <polyline
              key={`${seg.kind}${i}`}
              data-testid={seg.kind === 'solid' ? 'sparkline-solid' : 'sparkline-dashed'}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.5}
              strokeDasharray={seg.kind === 'dashed' ? '3,3' : undefined}
              vectorEffect="non-scaling-stroke"
              points={seg.points}
            />
          ))}
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
              background: 'var(--accent)',
              border: '1px solid var(--bg-card)',
            }}
          />
        )}
      </span>
      {/* 가격 축은 오른쪽 — 메인 차트(priceScaleId: 'right')와 같은 방향.
          라벨을 svg 안에 두지 않는 이유는 커서 도트와 같다: preserveAspectRatio
          =none 아래서는 글자도 가로세로 다른 비율로 늘어난다. */}
      <div
        data-testid="program-sparkline-axis"
        className="relative flex shrink-0 flex-col items-end justify-between font-data text-badge leading-none text-fg-dimmer tabular-nums"
      >
        <span data-testid="axis-label-max">{formatKoreanWonEok(vMax)}</span>
        {showZeroLabel && (
          <span
            data-testid="axis-label-zero"
            className="absolute right-0 -translate-y-1/2"
            style={{ top: `${zeroPct}%` }}
          >
            {formatKoreanWonEok(0)}
          </span>
        )}
        <span data-testid="axis-label-min">{formatKoreanWonEok(vMin)}</span>
      </div>
    </div>
  );
}

type SparkPoint = { t: number; v: number };
type SparkSegment =
  | { kind: 'solid'; pts: SparkPoint[] }
  | { kind: 'dashed'; pts: SparkPoint[] }; // always exactly 2 points

/** 이웃 점 사이 시간 간격이 임계를 넘으면 그 브리지만 2점 점선으로 떼어내고
 *  나머지는 solid run 으로 묶는다 (브로커 buildSegments 와 같은 규칙). */
export function buildTimeGapSegments(
  pts: readonly SparkPoint[],
  thresholdMs: number,
): SparkSegment[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ kind: 'solid', pts: [pts[0]] }];

  const out: SparkSegment[] = [];
  let run: SparkPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t - pts[i - 1].t <= thresholdMs) {
      run.push(pts[i]);
    } else {
      if (run.length >= 1) out.push({ kind: 'solid', pts: run });
      out.push({ kind: 'dashed', pts: [pts[i - 1], pts[i]] });
      run = [pts[i]];
    }
  }
  if (run.length >= 1) out.push({ kind: 'solid', pts: run });
  return out;
}

/** 커서 시각에서 "그려진 라인" 위의 금액 값(선형 보간). 카드 숫자
 *  (pickProgramTradePoint, 계단 의미론)와 달리 도트를 시각적 궤적 위에
 *  정확히 앉히기 위한 기하용. 궤적 범위 밖이면 null. */
function amountOnDrawnLineAt(pts: readonly SparkPoint[], cursorMs: number): number | null {
  if (pts.length === 0) return null;
  if (cursorMs < pts[0].t || cursorMs > pts[pts.length - 1].t) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].t <= cursorMs) lo = mid;
    else hi = mid - 1;
  }
  const a = pts[lo];
  const b = pts[lo + 1];
  if (!b || a.t === cursorMs) return a.v;
  const t = (cursorMs - a.t) / (b.t - a.t || 1);
  return a.v + (b.v - a.v) * t;
}

export function pickProgramTradePoint(
  points: readonly ProgramTradePoint[],
  cursorMs: number | null,
): ProgramTradePoint | null {
  const last = points.length > 0 ? points[points.length - 1] : null;
  if (last == null) return null;
  // latest 모드, 또는 커서가 마지막 관측 이후(미래 whitespace·다음날 칸)면 최신값
  // 고정 — 거래원·호가가 미래 whitespace 에서 latest 로 복귀하는 것과 일관.
  // 이 클램프가 없으면 아래 floor 가 "다음날 이하 최대 = 전날 마지막 점"을 집어
  // 전날 값이 새어나온다(병합 번들이 여러 날을 담기 때문).
  if (cursorMs === null || cursorMs >= last.t) return last;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i];
    if (p != null && p.t <= cursorMs) {
      // 날짜 경계 가드: floor 결과가 커서와 다른 KST 날짜면(그 날엔 관측 없음)
      // 전날 값으로 넘기지 않는다. 스파크라인의 날짜 스코프(realMsToYyyymmdd
      // 필터)와 대칭 — 카드 숫자와 궤적의 날짜 규칙을 일치시킨다.
      return realMsToYyyymmdd(p.t) === realMsToYyyymmdd(cursorMs) ? p : null;
    }
  }
  return null;
}

function formatSigned(value: number | null): string {
  if (value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatKoreanInt(value)}`;
}

function formatSignedAmount(value: number | null): string {
  if (value === null) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatKoreanWonEok(value)}`;
}

function signedClass(value: number | null): string {
  if (value === null || value === 0) return 'text-fg-dimmer';
  return value > 0 ? 'text-price-up' : 'text-price-down';
}

function formatTime(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
