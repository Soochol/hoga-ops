import type { DayVolumeDistribution } from '../api/types';
import { classifyWithinSegment } from '../util/sessionTime';
import { unixMsToKSTClock } from '../util/time';
import { SidebarState } from './SidebarSurface';

type Props = {
  profile: DayVolumeDistribution | null | undefined;
  cursorMs: number | null;
  closePoints?: readonly ClosePoint[];
  color: string;
  maxColor: string;
};

type ClosePoint = {
  t_ms: number;
  close: number;
};

const PRICE_AXIS_WIDTH_PX = 48;
// 가격 눈금이 POC 라벨과 이 거리(%) 안으로 붙으면 눈금을 양보한다(POC가 우선).
const PRICE_TICK_POC_CLEARANCE_PCT = 9;

export function VolumeDistributionCard({
  profile,
  cursorMs,
  closePoints = [],
  color,
  maxColor,
}: Props) {
  if (profile === undefined) {
    return <SidebarState>—</SidebarState>;
  }
  if (profile === null || profile.bins.length === 0) {
    return <SidebarState>매물대 분포 없음</SidebarState>;
  }

  const maxQty = Math.max(0, ...profile.bins.map((bin) => bin.qty));
  const rows = [...profile.bins].reverse();
  const cursorPhase = cursorMs == null
    ? null
    : classifyWithinSegment({
      sessionOpenMs: profile.session_open_ms,
      sessionCloseMs: profile.session_close_ms,
    }, cursorMs);
  const markerVisible = cursorMs != null && (cursorPhase === 'regular' || cursorPhase === 'auction');
  const lastCloseMs = closePoints.length > 0 ? closePoints[closePoints.length - 1]?.t_ms : null;
  const axisEndMs = Math.max(profile.session_open_ms, lastCloseMs ?? profile.last_trade_ms ?? profile.session_close_ms);
  const markerPct = markerVisible && axisEndMs > profile.session_open_ms
    ? ((cursorMs - profile.session_open_ms) / (axisEndMs - profile.session_open_ms)) * 100
    : 0;
  const closeCoords = buildCloseCoords({
    points: closePoints,
    priceMin: profile.price_min,
    priceMax: profile.price_max,
    sessionOpenMs: profile.session_open_ms,
    axisEndMs,
  });
  const closePath = closeCoords
    ? closeCoords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
    : null;
  const closeEnd = closeCoords ? closeCoords[closeCoords.length - 1] : null;
  const maxBinIndex = maxQty > 0 ? rows.findIndex((bin) => bin.qty === maxQty) : -1;
  const pocBin = maxBinIndex >= 0 ? rows[maxBinIndex] : null;
  const pocPct = maxBinIndex >= 0 ? ((maxBinIndex + 0.5) / rows.length) * 100 : null;
  const priceRange = profile.price_max - profile.price_min;
  const priceTicks = priceRange > 0
    ? [0, 50, 100]
      .filter((pct) => pocPct == null || Math.abs(pct - pocPct) >= PRICE_TICK_POC_CLEARANCE_PCT)
      .map((pct) => ({ pct, label: formatPrice(profile.price_max - (pct / 100) * priceRange) }))
    : [];
  // 데이터가 세션 시작 시각뿐이면(축 스팬 0) 예정 세션 종료를 눈금 폴백으로 쓴다.
  // 이 경우 종가 라인·커서 마커는 어차피 비활성이라 축 불일치가 생기지 않는다.
  const tickEndMs = axisEndMs > profile.session_open_ms ? axisEndMs : profile.session_close_ms;
  const timeTicks = tickEndMs > profile.session_open_ms
    ? [
      profile.session_open_ms,
      profile.session_open_ms + (tickEndMs - profile.session_open_ms) / 2,
      tickEndMs,
    ].map((ms) => unixMsToKSTClock(ms).slice(0, 5))
    : null;
  return (
    <div
      data-testid="volume-distribution-card"
      className="flex h-full min-h-0 flex-col gap-1 px-2 py-2 text-[11px]"
    >
      <div className="flex min-h-0 flex-1 gap-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {markerVisible && (
            <div
              data-testid="volume-distribution-cursor-marker"
              className="pointer-events-none absolute bottom-0 top-0 border-l border-dotted border-accent"
              style={{ left: `${Math.min(100, Math.max(0, markerPct))}%` }}
            />
          )}
          {closePath && (
            <svg
              data-testid="volume-distribution-close-graph"
              className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
              preserveAspectRatio="none"
              viewBox="0 0 100 100"
            >
              <path
                d={closePath}
                fill="none"
                stroke="var(--bg-card)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3.5"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={closePath}
                fill="none"
                stroke="var(--fg)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity="0.92"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {closeEnd && (
            <div
              data-testid="volume-distribution-close-dot"
              className="pointer-events-none absolute z-10 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${closeEnd[0]}%`,
                top: `${closeEnd[1]}%`,
                background: 'var(--fg)',
                border: '1.5px solid var(--bg-card)',
              }}
            />
          )}
          <div className="flex h-full min-h-0 flex-col gap-1">
            {rows.map((bin, index) => {
              const isMax = maxQty > 0 && bin.qty === maxQty;
              const width = maxQty > 0 ? `${(bin.qty / maxQty) * 100}%` : '0%';
              return (
                <div
                  key={`${bin.price_low}-${bin.price_high}-${index}`}
                  data-testid="volume-distribution-row"
                  className="min-h-0"
                >
                  <div
                    data-testid="volume-distribution-track"
                    className="h-2 overflow-hidden rounded-[1px]"
                    style={{ background: 'var(--grid)' }}
                  >
                    <div
                      data-testid={isMax ? 'volume-distribution-max-bar' : 'volume-distribution-bar'}
                      className="h-full rounded-[1px]"
                      style={{ width, backgroundColor: isMax ? maxColor : color, opacity: isMax ? 1 : 0.78 }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div
          data-testid="volume-distribution-price-axis"
          className="relative shrink-0 font-mono text-[10px] leading-none tabular-nums text-fg-dimmer"
          style={{ width: PRICE_AXIS_WIDTH_PX }}
        >
          {priceTicks.map(({ pct, label }) => (
            <span
              key={pct}
              className="absolute right-0"
              style={{
                top: `${pct}%`,
                transform: pct === 0 ? 'none' : pct === 100 ? 'translateY(-100%)' : 'translateY(-50%)',
              }}
            >
              {label}
            </span>
          ))}
          {pocBin && pocPct != null && (
            <span
              data-testid="volume-distribution-poc-label"
              className="absolute right-0 -translate-y-1/2 font-medium"
              style={{ top: `${pocPct}%`, color: maxColor }}
            >
              {formatPrice((pocBin.price_low + pocBin.price_high) / 2)}
            </span>
          )}
        </div>
      </div>
      <div
        data-testid="volume-distribution-time-axis"
        style={{ paddingRight: PRICE_AXIS_WIDTH_PX + 4 }}
      >
        <div className="relative h-4 border-t border-border/70 font-mono text-[10px] leading-4 tabular-nums text-fg-dimmer">
          {timeTicks && (
            <>
              <span className="absolute left-0 top-0">{timeTicks[0]}</span>
              <span className="absolute left-1/2 top-0 -translate-x-1/2">{timeTicks[1]}</span>
              <span className="absolute right-0 top-0">{timeTicks[2]}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatPrice(value: number): string {
  return Math.round(value).toLocaleString('ko-KR');
}

function buildCloseCoords({
  points,
  priceMin,
  priceMax,
  sessionOpenMs,
  axisEndMs,
}: {
  points: readonly ClosePoint[];
  priceMin: number;
  priceMax: number;
  sessionOpenMs: number;
  axisEndMs: number;
}): ReadonlyArray<readonly [number, number]> | null {
  if (points.length < 2 || axisEndMs <= sessionOpenMs || priceMax <= priceMin) return null;
  const coords = points
    .filter((point) =>
      Number.isFinite(point.t_ms) &&
      Number.isFinite(point.close) &&
      point.t_ms >= sessionOpenMs &&
      point.t_ms <= axisEndMs &&
      point.close >= priceMin &&
      point.close <= priceMax,
    )
    .map((point) => {
      const x = ((point.t_ms - sessionOpenMs) / (axisEndMs - sessionOpenMs)) * 100;
      const y = ((priceMax - point.close) / (priceMax - priceMin)) * 100;
      return [clampPct(x), clampPct(y)] as const;
    });
  if (coords.length < 2) return null;
  return coords;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}
