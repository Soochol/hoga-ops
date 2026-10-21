import { useLayoutEffect, useMemo, useState, type CSSProperties } from 'react';
import './VolumeDistributionCard.css';
import { priceTickPcts } from './volumePriceAxis';
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
  /** Full-day observations keep the time axis fixed while profile follows hover. */
  axisProfile?: DayVolumeDistribution | null;
};

type ClosePoint = {
  t_ms: number;
  close: number;
};

const EMPTY_CLOSE_POINTS: readonly ClosePoint[] = [];
// bar 행 슬롯(= 컨테이너 높이 / bin 수) 중 간격이 차지하는 비율. 옛 고정 치수
// (트랙 8px + gap 4px)의 밀도감을 그대로 옮긴 값이다. px 이 아닌 비율이라야
// 좌표가 순수 백분율로 닫히고(가격축과 같은 단위), 창이 작아져도 간격이 트랙을
// 잡아먹지 않는다.
const ROW_GAP_RATIO = 1 / 3;

export function VolumeDistributionCard({
  profile,
  cursorMs,
  closePoints = EMPTY_CLOSE_POINTS,
  color,
  maxColor,
  axisProfile = profile,
}: Props) {
  const [axisElement, setAxisElement] = useState<HTMLDivElement | null>(null);
  const [axisMetrics, setAxisMetrics] = useState({ height: 240, fontSize: 10.5 });
  useLayoutEffect(() => {
    if (!axisElement) return;
    const update = () => {
      const height = axisElement.clientHeight;
      if (height <= 0) return;
      const fontSize = parseFloat(getComputedStyle(axisElement).fontSize);
      setAxisMetrics(previous => previous.height === height && previous.fontSize === fontSize
        ? previous : { height, fontSize });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(axisElement);
    return () => observer.disconnect();
  }, [axisElement]);
  const priceMin = profile?.price_min, priceMax = profile?.price_max;
  const observedPrices = useMemo(() => closePoints
    .filter(point => Number.isFinite(point.t_ms) && Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.t_ms - b.t_ms), [closePoints]);
  const timeRange = useMemo(() => {
    if (observedPrices.length > 0) return { from: observedPrices[0].t_ms, to: observedPrices.at(-1)!.t_ms };
    if (!axisProfile) return null;
    const starts = axisProfile.bins.flatMap(bin => bin.qty > 0 && bin.first_trade_ms != null
      && Number.isFinite(bin.first_trade_ms) ? [bin.first_trade_ms] : []);
    const from = starts.length ? Math.min(...starts) : axisProfile.session_open_ms;
    const to = axisProfile.last_trade_ms ?? axisProfile.session_close_ms;
    return { from, to: Math.max(from, to) };
  }, [observedPrices, axisProfile]);
  const geometryFrom = timeRange?.from ?? null;
  const geometryEnd = timeRange?.to ?? null;
  const closeGeometry = useMemo(() => {
    if (priceMin == null || priceMax == null || geometryFrom == null || geometryEnd == null) return { coords: null, path: null };
    const coords = buildCloseCoords({ points: observedPrices, priceMin, priceMax, sessionOpenMs: geometryFrom, axisEndMs: geometryEnd });
    const path = coords ? coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') : null;
    return { coords, path };
  }, [observedPrices, priceMin, priceMax, geometryFrom, geometryEnd]);
  if (profile === undefined) {
    return <SidebarState>—</SidebarState>;
  }
  if (profile === null || profile.bins.length === 0) {
    return <SidebarState>매물대 분포 없음</SidebarState>;
  }

  const maxQty = Math.max(0, ...profile.bins.map((bin) => bin.qty));
  const rows = [...profile.bins].reverse();
  // One observed time domain drives the price path, bars, cursor and labels.
  const axisFromMs = timeRange?.from ?? profile.session_open_ms;
  const axisEndMs = timeRange?.to ?? axisFromMs;
  const axisSpanMs = axisEndMs - axisFromMs;
  // 커서 마커는 **축** 전체에서 유효하다 — 정규장 밖(NXT 시간대) 을 가리켜도
  // 라인은 거기 있으므로 마커만 사라지면 읽는 사람이 위치를 잃는다.
  const cursorPhase = cursorMs == null
    ? null
    : classifyWithinSegment({
      sessionOpenMs: axisFromMs,
      sessionCloseMs: Math.max(axisEndMs, profile.session_close_ms),
    }, cursorMs);
  const markerVisible = cursorMs != null && (cursorPhase === 'regular' || cursorPhase === 'auction');
  const markerPct = markerVisible && axisSpanMs > 0
    ? ((cursorMs - axisFromMs) / axisSpanMs) * 100
    : 0;
  // bar 가 차지할 가로 구간 = 집계 창을 축 백분율로 옮긴 것. 두 창이 같으면
  // (venue=KRX·저장뷰) 0~100% 이라 기존과 동일하게 전체 폭을 쓴다.
  const binWindow = axisSpanMs > 0
    ? {
      startPct: clampPct(((profile.session_open_ms - axisFromMs) / axisSpanMs) * 100),
      endPct: clampPct(((Math.min(profile.session_close_ms, axisEndMs) - axisFromMs) / axisSpanMs) * 100),
    }
    : { startPct: 0, endPct: 100 };
  // 축 경계와 겹치는 끝은 선을 그리지 않는다 — 카드 가장자리에 붙은 선은 정보가
  // 아니라 테두리로 읽힌다.
  const binWindowEdgePcts = [
    ...(binWindow.startPct > 0 ? [binWindow.startPct] : []),
    ...(binWindow.endPct < 100 ? [binWindow.endPct] : []),
  ];
  const closeCoords = closeGeometry.coords;
  const closePath = closeGeometry.path;
  const closeEnd = closeCoords ? closeCoords[closeCoords.length - 1] : null;
  const maxBinIndex = maxQty > 0 ? rows.findIndex((bin) => bin.qty === maxQty) : -1;
  const pocBin = maxBinIndex >= 0 ? rows[maxBinIndex] : null;
  const pocPct = maxBinIndex >= 0 ? ((maxBinIndex + 0.5) / rows.length) * 100 : null;
  const priceRange = profile.price_max - profile.price_min;
  const priceTicks = priceRange > 0
    ? priceTickPcts(axisMetrics.height, axisMetrics.fontSize, pocPct)
      .map((pct) => ({ pct, label: formatPrice(profile.price_max - (pct / 100) * priceRange) }))
    : [];
  // A single observed point gets one label rather than an empty future session.
  const timeTicks = axisSpanMs > 0
    ? [
      axisFromMs,
      axisFromMs + axisSpanMs / 2,
      axisEndMs,
    ].map((ms) => unixMsToKSTClock(ms).slice(0, 5))
    : [unixMsToKSTClock(axisFromMs).slice(0, 5)];
  return (
    <div
      data-testid="volume-distribution-card"
      className="volume-distribution-card flex h-full min-h-0 flex-col gap-1 py-2 font-data text-xs"
      style={{ '--volume-distribution-color': color, '--volume-distribution-max-color': maxColor } as CSSProperties}
    >
      <div className="volume-distribution-legend" aria-label="매물대 범례">
        <span><i className="volume-distribution-max-swatch" aria-hidden="true" />최대 거래량 구간</span>
        {closePath && <span><i className="volume-distribution-price-swatch" aria-hidden="true" />가격</span>}
      </div>
      <div className="volume-distribution-chart-grid min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {markerVisible && (
            <div
              data-testid="volume-distribution-cursor-marker"
              className="pointer-events-none absolute bottom-0 top-0 border-l border-dotted border-accent"
              style={{ left: `${Math.min(100, Math.max(0, markerPct))}%` }}
            />
          )}
          {/* 집계 창의 양 끝 — 막대가 축 중간에서 시작·종료하는 이유를 말해준다.
              축과 창이 같으면(venue=KRX·저장뷰) 양쪽 다 렌더하지 않아 선이 늘지
              않는다. 커서 마커(dotted·accent)보다 한 단계 약한 위계로 둔다. */}
          {binWindowEdgePcts.map((pct) => (
            <div
              key={pct}
              data-testid="volume-distribution-bin-window-edge"
              className="pointer-events-none absolute bottom-0 top-0 border-l border-dashed border-border"
              style={{ left: `${pct}%` }}
            />
          ))}
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
                stroke="var(--fg-dim)"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity="0.8"
                strokeWidth="1.25"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {closeEnd && (
            <div
              data-testid="volume-distribution-close-dot"
              className="pointer-events-none absolute z-10 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${closeEnd[0]}%`,
                top: `${closeEnd[1]}%`,
                background: 'var(--fg-dim)',
                opacity: 0.8,
              }}
            />
          )}
          {/* bar 행은 종가 라인·가격 눈금·POC 라벨과 같은 백분율 좌표계에 절대배치한다.
              고정 높이 스택이던 시절엔 행 높이(8px+gap)가 컨테이너 높이와 무관해서
              창이 커지면 bar 는 상단에만 몰리고 라인만 전 구간으로 늘어났다 —
              사이드바 카드 높이에서만 우연히 맞던 정합이 창 승격으로 깨진 것.
              bin 은 [price_min, price_max] 균등 분할이라(continuousTradeVolumeDistribution)
              bin i 는 백분율 구간 [i/N, (i+1)/N] 에 정확히 대응한다.

              가로로는 집계 창(binWindow)에 갇힌다 — 확장창에서 막대가 축 전체로
              뻗으면 정규장 값이 NXT 시간대까지 걸쳐 있는 것처럼 읽힌다. */}
          <div
            data-testid="volume-distribution-bar-window"
            className="absolute inset-y-0"
            style={{ left: `${binWindow.startPct}%`, right: `${100 - binWindow.endPct}%` }}
          >
            {rows.map((bin, index) => {
              const isMax = maxQty > 0 && bin.qty === maxQty;
              const width = maxQty > 0 ? `${(bin.qty / maxQty) * 100}%` : '0%';
              return (
                <div
                  key={`${bin.price_low}-${bin.price_high}-${index}`}
                  data-testid="volume-distribution-row"
                  className="absolute inset-x-0"
                  style={{
                    // 간격을 위아래로 절반씩 나눠 넣어 트랙 중심이 정확히
                    // (index + 0.5) / N — 즉 bin 중간가의 가격 좌표 — 에 놓인다.
                    top: `${((index + ROW_GAP_RATIO / 2) / rows.length) * 100}%`,
                    height: `${((1 - ROW_GAP_RATIO) / rows.length) * 100}%`,
                  }}
                >
                  <div
                    data-testid="volume-distribution-track"
                    className="h-full overflow-hidden rounded-sm"
                  >
                    <div
                      data-testid={isMax ? 'volume-distribution-max-bar' : 'volume-distribution-bar'}
                      className={`h-full rounded-sm ${isMax ? 'volume-distribution-max-bar' : 'volume-distribution-bar'}`}
                      style={{ width }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div
          ref={setAxisElement}
          data-testid="volume-distribution-price-axis"
          className="relative shrink-0 font-data text-2xs leading-none tabular-nums text-fg-dim"
        >
          {/* Absolute ticks do not contribute intrinsic width. Reserve every bin
              midpoint too so moving the POC cannot move the price/time axes. */}
          <span className="volume-distribution-axis-budget font-medium" aria-hidden="true">
            {[...new Set([profile.price_min, profile.price_max, ...profile.bins.map(bin => (bin.price_low + bin.price_high) / 2)]
              .map(value => formatPrice(value).replace(/\d/g, '8')))].map(value => <span key={value} data-figure={value} />)}
          </span>
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
              title={`최대 거래량 가격 · ${formatPrice((pocBin.price_low + pocBin.price_high) / 2)}원`}
              className="volume-distribution-poc-label absolute right-0 -translate-y-1/2 font-medium"
              style={{ '--volume-poc-position': `${pocPct}%` } as CSSProperties}
            >
              {formatPrice((pocBin.price_low + pocBin.price_high) / 2)}
            </span>
          )}
        </div>
        <div
          data-testid="volume-distribution-time-axis"
          className="volume-distribution-time-axis"
        >
          <div className="relative h-4 border-t border-border/70 font-data text-2xs leading-4 tabular-nums text-fg-dim">
            {timeTicks && (
              <>
                <span className="absolute left-0 top-0">{timeTicks[0]}</span>
                {timeTicks.length > 1 && <>
                  <span className="absolute left-1/2 top-0 -translate-x-1/2">{timeTicks[1]}</span>
                  <span className="absolute right-0 top-0">{timeTicks[2]}</span>
                </>}
              </>
            )}
          </div>
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
