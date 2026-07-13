import { useMemo } from 'react';
import { InvestorTrendEstimateCard } from '../sidebar/InvestorTrendEstimateCard';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import ProgramTradeSummaryCard from '../sidebar/ProgramTradeSummaryCard';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from '../sidebar/cursorDetailResolver';
import { VolumeDistributionCard } from '../sidebar/VolumeDistributionCard';
import type { LiveSeriesData } from '../api/liveSeries';
import type { ProgramTradeSeries } from '../api/types';
import {
  aggregateBrokerSeries,
  latestOrderbookSnapshot,
  orderbookSnapshotAtCursor,
} from './liveSidebarAdapters';
import { TIMEFRAME_TO_MS, type RangeBundle, type Timeframe } from '../api/types';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import { useLivePageStore } from '../state/livePage';
import { type LiveCardKey, useLiveLayoutStore } from '../state/liveLayout';
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
} from '../api/useLiveCursor';
import { useLiveInvestorTrendEstimate } from '../api/liveInvestorTrendEstimate';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLiveVenueStore } from '../state/liveVenue';
import type { MinuteTimeframe } from '../state/livePage';
import { isMinuteTimeframe } from '../state/livePage';
import { LiveDetailPanel } from './LiveDetailPanel';
import { realMsToYyyymmdd } from './liveDateTime';
import {
  buildCandleDateIndex,
  firstTrailingSinglePriceBookMs,
  volumeDistributionClosePointsFromCandles,
} from './continuousTradeVolumeDistribution';
import {
  useLiveDistributionTrades,
  useLiveTodayVolumeDistribution,
} from './useLiveVolumeDistribution';
import { useVolumeDistributionCutoffProfile } from './useVolumeDistributionCutoffProfile';

interface Props {
  code: string | null;
  /** Owned by LivePage's single useLiveSeries call (ADR-0040 spirit). The
   * sidebar must NOT call useLiveSeries itself — that would open a second
   * SSE connection and a parallel buffer that drifts out of sync on HMR
   * re-mounts. */
  live: LiveSeriesData;
  bundle?: RangeBundle | null;
  todayKst?: string;
  programTrade?: ProgramTradeSeries | null;
}

/**
 * Live Sidebar — two cards (10호가 / 거래원) wired to live data.
 *
 * Reuses the shared sidebar cards inside a live-only detail stack. The data
 * wiring differs:
 *   - /replay uses cursor-keyed REST hooks (useCursor, useBrokerSeriesForDay)
 *   - /live uses useLiveSeries (initial REST + SSE) in latest mode
 *   - /live uses useLiveCursor hooks in spot mode (cursor set via hover)
 *
 * The mode header was removed to give the dense 10호가 / 거래원 / 잠정거래원
 * panels more vertical room.
 *
 * The third "체결" card was removed 2026-05-28 (ADR-0047). The chart's
 * 체결강도 pane provides equivalent information in compact form.
 */
export function LiveSidebar({ code, live, bundle = null, todayKst = '', programTrade = null }: Props) {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const stockCode = code && !code.startsWith('index:') ? code : null;
  const activeBundle = bundle;
  // 매물대 카드가 접혀 있으면 무거운 매물대 훅(오늘 증분 + 커서 컷오프)을 끈다.
  // SSE 는 LivePage 소유라 불변(ADR-0040) — 카드 언마운트로 렌더만 멈추고,
  // 이 게이트로 재계산 자체를 멈춘다.
  const volumeCardCollapsed = useLiveLayoutStore((s) => s.rightCardCollapsed.volumeDistribution ?? false);

  // Spot mode is minute-only (ADR-0044): D/W/M have no per-cursor parquet. The
  // chart publishes sidebarCursorMs for spot/sidebar consumers, so gate spot
  // entry on the timeframe here — NOT on cursor presence alone.
  const cursorScope = resolveCursorDetailScope({ cursorMs, timeframe });
  const isSpot = cursorScope.kind === 'minute-cursor';
  const spotCursorMs = cursorScope.kind === 'minute-cursor' ? cursorScope.cursorMs : null;

  // Latest-mode data flows through `live` — LivePage owns the single
  // useLiveSeries call site. useSpot hooks in spot mode sit dormant when
  // sidebarCursorMs is null, no extra fetches.
  const { ob, broker } = live;
  const latestOrderbook = useMemo(() => latestOrderbookSnapshot(ob), [ob]);
  const latestBrokerSeries = useMemo(() => aggregateBrokerSeries(broker), [broker]);
  const latestBrokerTs =
    broker.length > 0 ? (broker[broker.length - 1].t_ms as number) : Date.now();

  // Spot-mode data (dormant when cursorMs null).
  const spotTimeframe: MinuteTimeframe | null =
    cursorScope.kind === 'minute-cursor'
      ? cursorScope.minuteTimeframe
      : timeframe && isMinuteTimeframe(timeframe)
        ? timeframe
        : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code: stockCode, timeframe: spotTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code: stockCode, timeframe: spotTimeframe });
  const investorTrendEstimate = useLiveInvestorTrendEstimate(stockCode);

  // 10호가 가격 색 기준 = KRX 전일 종가. quote.baseline_price 는 venue 불변(2026-07-10 실측:
  // KRX/UN/NXT 모두 동일 — KIS inter2_prdy_clpr 이 어느 venue든 같은 전일 종가 보고)이라,
  // 현재 venue quote 를 그대로 읽으면 = KRX 전일 종가. LiveStatusBar 가 이미 (code, venue) 로
  // 폴링 중이므로 캐시 공유 → 추가 API 호출 0. 등락률 배지와 문자 그대로 같은 quote 라 기준 일치.
  const venue = useLiveVenueStore((s) => s.venue);
  const quote = useQuoteByCode(stockCode ? [stockCode] : [], venue).get(stockCode ?? '');
  const baselinePrice = quote?.baseline_price ?? null;

  // Axis for Auction Mask in spot mode.
  const axis = useLiveAxisStore((s) => s.axis);
  const maskRatio = useAuctionMaskActive(axis, spotCursorMs);

  // Branch on spot vs latest.
  const spotSnap = spotOrderbook === undefined ? undefined : spotOrderbook.snapshot;
  const spotAvailableFrom = spotOrderbook?.available_from ?? null;
  // ADR-0044 amendment (2026-06-11): the promoted-parquet spot path lags the
  // live edge by ~2–5 min (Today Promotion cadence, ADR-0043), so hovering a
  // recent candle returned a null snapshot → an empty sidebar (reported bug).
  // The SSE buffer (`ob`) already holds the last ~15 min of books, covering that
  // lag, so when parquet has nothing for the hovered bucket we derive that
  // candle's REAL book from the buffer client-side (bucket-representative parity
  // in liveSidebarAdapters). Parquet stays authoritative — this runs only when
  // spotSnap is null, so the two sources never answer for the same time. The
  // hover FETCHER stays parquet-only (ADR-0044 invariant intact); the fallback
  // is composed here at the LiveSidebar layer.
  const bufferSnap = useMemo(
    () =>
      isSpot && spotSnap === null && spotTimeframe !== null && spotCursorMs !== null
        ? orderbookSnapshotAtCursor(ob, spotCursorMs, TIMEFRAME_TO_MS[spotTimeframe as Timeframe])
        : null,
    [isSpot, spotSnap, spotTimeframe, spotCursorMs, ob],
  );
  const orderbookForCard = resolveOrderbookCardSnapshot({
    scope: cursorScope,
    spotSnapshot: spotSnap,
    inactiveSnapshot: latestOrderbook,
    bufferFallbackSnapshot: bufferSnap,
  });
  const inactiveBrokerSeriesForCard = broker.length === 0 ? undefined : latestBrokerSeries;
  const brokerCard = resolveBrokerCardProps({
    scope: cursorScope,
    spotSeries: spotBrokers,
    inactiveSeries: inactiveBrokerSeriesForCard,
    inactiveCursorMs: latestBrokerTs,
  });
  const brokerCursorMs = brokerCard.cursorMs;
  const activeVolumeDistributionDate = spotCursorMs !== null
    ? realMsToYyyymmdd(spotCursorMs)
    : (activeBundle?.segments[activeBundle.segments.length - 1]?.date ?? todayKst ?? null);
  const candleDateIndex = useMemo(
    () => buildCandleDateIndex(activeBundle?.candles ?? []),
    [activeBundle?.candles],
  );
  const activeVolumeDistributionCandles = useMemo(() => {
    if (!activeBundle || !activeVolumeDistributionDate) return [];
    return candleDateIndex.get(activeVolumeDistributionDate) ?? [];
  }, [activeBundle, activeVolumeDistributionDate, candleDateIndex]);
  const persistedVolumeDistributions = activeBundle?.volume_distributions ?? [];
  // 틱-증분 flatten: OFF면 stable EMPTY, ON이면 신규 스냅샷만 접는다
  // (기존 flatMap은 기능 OFF여도 체결 틱마다 15분 버퍼 전체를 재물질화했다).
  const liveDistribution = useLiveDistributionTrades(live.trade, volumeDistributionEnabled);
  const liveDistributionTrades = liveDistribution.trades;
  const todayContinuousBeforeMs = useMemo(() => {
    if (!activeBundle || !todayKst) return null;
    const todaySegment = activeBundle.segments.find((segment) => segment.date === todayKst);
    if (!todaySegment) return null;
    return firstTrailingSinglePriceBookMs(ob, todaySegment.session_close_ms);
  }, [activeBundle, todayKst, ob]);
  const todayVolumeSegment = useMemo(
    () => activeBundle?.segments.find((segment) => segment.date === todayKst) ?? null,
    [activeBundle, todayKst],
  );
  const persistedTodayVolumeDistribution = useMemo(
    () => (todayKst
      ? persistedVolumeDistributions.find((profile) => profile.date === todayKst) ?? null
      : null),
    [persistedVolumeDistributions, todayKst],
  );
  // 오늘 분포: 베이스(승격 프로필·캔들 그리드·세션 경계) 불변인 동안은 신규
  // 체결 델타만 fold — 기존엔 체결 틱마다 버퍼 전체를 재계산/재병합했다.
  const todayVolumeDistribution = useLiveTodayVolumeDistribution({
    enabled: volumeDistributionEnabled && !!activeBundle && !volumeCardCollapsed,
    stockCode,
    todayKst,
    isMinute: isMinuteTimeframe(timeframe),
    rangeCount: volumeDistributionRangeCount,
    todayCandles: (todayKst ? candleDateIndex.get(todayKst) : undefined) ?? [],
    todaySegment: todayVolumeSegment,
    persistedToday: persistedTodayVolumeDistribution,
    liveTrades: liveDistribution,
    continuousBeforeMs: todayContinuousBeforeMs,
  });
  const activeVolumeDistribution = useMemo(() => {
    // 구 selectVolumeDistributionProfile 의미론: 비활성=undefined,
    // 오늘=증분 유지 프로필, 과거일=persisted 그대로(없으면 null).
    if (!volumeDistributionEnabled) return undefined;
    if (activeVolumeDistributionDate && activeVolumeDistributionDate === todayKst) {
      return todayVolumeDistribution;
    }
    return persistedVolumeDistributions.find(
      (profile) => profile.date === activeVolumeDistributionDate,
    ) ?? null;
  }, [
    volumeDistributionEnabled,
    activeVolumeDistributionDate,
    todayKst,
    todayVolumeDistribution,
    persistedVolumeDistributions,
  ]);
  const activeVolumeDistributionPriceRange = useMemo(() => {
    if (
      activeVolumeDistribution
      && Number.isFinite(activeVolumeDistribution.price_min)
      && Number.isFinite(activeVolumeDistribution.price_max)
      && activeVolumeDistribution.price_min < activeVolumeDistribution.price_max
    ) {
      return {
        min: activeVolumeDistribution.price_min,
        max: activeVolumeDistribution.price_max,
      };
    }
    return candlePriceRange(activeVolumeDistributionCandles);
  }, [activeVolumeDistribution, activeVolumeDistributionCandles]);
  const cutoffVolumeDistribution = useVolumeDistributionCutoffProfile({
    enabled: volumeDistributionEnabled && volumeDistributionHoverCutoffEnabled && isSpot && !volumeCardCollapsed,
    code: stockCode,
    timeframe: spotTimeframe,
    date: activeVolumeDistributionDate,
    cursorMs: spotCursorMs,
    todayKst,
    rangeCount: volumeDistributionRangeCount,
    finalProfile: activeVolumeDistribution,
    priceRange: activeVolumeDistributionPriceRange,
    liveTrades: liveDistributionTrades,
    candles: activeVolumeDistributionCandles,
    segment: activeBundle?.segments.find((segment) => segment.date === activeVolumeDistributionDate) ?? null,
  });
  const activeVolumeDistributionClosePoints = useMemo(() => {
    return activeVolumeDistributionDate
      ? volumeDistributionClosePointsFromCandles(activeVolumeDistributionCandles)
      : [];
  }, [activeVolumeDistributionCandles, activeVolumeDistributionDate]);

  // T14b: "다음 가용: HH:MM" hint above orderbook table when spot orderbook
  // has no snapshot yet AND the SSE buffer can't fill it either (a genuine gap,
  // not the recent lag the buffer now covers) but backend knows when the first
  // row arrives.
  const showAvailableHint =
    isSpot &&
    spotOrderbook !== undefined &&
    spotSnap === null &&
    bufferSnap === null &&
    spotAvailableFrom !== null;

  // 접힌 카드 헤더의 "데이터 없음" 점. 매물대는 게이트된 훅 출력(위에서 접힘 시 공허하게
  // 비어짐)이 아니라 언게이트 입력(persisted 프로필/캔들 유무)으로 판정 — 접혀도 진실을 말한다.
  const emptyByCard = useMemo<Partial<Record<LiveCardKey, boolean>>>(
    () => ({
      orderbook: orderbookForCard == null,
      brokers: !brokerCard.series || brokerCard.series.length === 0,
      volumeDistribution:
        !activeBundle
        || (!persistedVolumeDistributions.some((profile) => profile.date === activeVolumeDistributionDate)
          && activeVolumeDistributionCandles.length === 0),
      program: (programTrade?.points?.length ?? 0) === 0,
      investor: (investorTrendEstimate.data?.rows?.length ?? 0) === 0,
    }),
    [
      orderbookForCard,
      brokerCard.series,
      activeBundle,
      persistedVolumeDistributions,
      activeVolumeDistributionDate,
      activeVolumeDistributionCandles,
      programTrade,
      investorTrendEstimate.data,
    ],
  );

  return (
    <div
      data-testid="live-sidebar"
      style={{
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'visible',
        background: 'var(--bg-card)',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflow: 'visible' }}>
        <LiveDetailPanel
          orderbook={
            <>
              {showAvailableHint && (
                <div
                  data-testid="orderbook-available-hint"
                  style={{
                    padding: 'var(--space-xs) var(--space-md)',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--fg-dimmer)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  다음 가용: {formatTime(spotAvailableFrom!)}
                </div>
              )}
              <OrderbookTable snapshot={orderbookForCard} baselinePrice={baselinePrice} />
              <TotalQtyBar snapshot={orderbookForCard} maskRatio={maskRatio} />
            </>
          }
          volumeDistribution={
            <VolumeDistributionCard
              profile={cutoffVolumeDistribution}
              cursorMs={isSpot ? spotCursorMs : brokerCursorMs}
              closePoints={activeVolumeDistributionClosePoints}
              color={volumeDistributionColor}
              maxColor={volumeDistributionMaxColor}
            />
          }
          program={
            <ProgramTradeSummaryCard
              series={programTrade}
              cursorMs={spotCursorMs}
            />
          }
          brokers={
            <BrokerTrajectoryTable series={brokerCard.series} cursorMs={brokerCard.cursorMs} />
          }
          investor={<InvestorTrendEstimateCard query={investorTrendEstimate} />}
          emptyByCard={emptyByCard}
        />
      </div>
    </div>
  );
}

// KST formatting via toLocaleTimeString — matches the rest of the sidebar
// (OrderbookTable, BrokerTrajectoryTable). Local-tz machine-time clocks
// would desync from the chart x-axis on non-KST workstations.
function formatTime(ts_ms: number): string {
  return new Date(ts_ms).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function candlePriceRange(candles: readonly { low: number; high: number }[]): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (Number.isFinite(candle.low)) min = Math.min(min, candle.low);
    if (Number.isFinite(candle.high)) max = Math.max(max, candle.high);
  }
  return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}
