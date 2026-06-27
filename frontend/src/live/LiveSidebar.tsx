import { useMemo } from 'react';
import { InvestorTrendEstimateCard } from '../sidebar/InvestorTrendEstimateCard';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import ProgramTradeSummaryCard from '../sidebar/ProgramTradeSummaryCard';
import TotalQtyBar from '../sidebar/TotalQtyBar';
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
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
} from '../api/useLiveCursor';
import { useLiveInvestorTrendEstimate } from '../api/liveInvestorTrendEstimate';
import type { MinuteTimeframe } from '../state/livePage';
import { isMinuteTimeframe } from '../state/livePage';
import { LiveDetailPanel } from './LiveDetailPanel';
import { realMsToYyyymmdd } from './liveDateTime';
import {
  computeContinuousTradeVolumeDistribution,
  firstTrailingSinglePriceBookMs,
  selectVolumeDistributionProfile,
  volumeDistributionClosePoints,
} from './continuousTradeVolumeDistribution';
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
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionHoverCutoffEnabled = useLivePageStore((s) => s.volumeDistributionHoverCutoffEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const stockCode = code && !code.startsWith('index:') ? code : null;
  const activeBundle = bundle;

  // Spot mode is minute-only (ADR-0044): D/W/M have no per-cursor parquet. The
  // chart still publishes cursorMs on D for the Pane Legend, so gate spot entry
  // on the timeframe here — NOT on cursorMs alone.
  const isSpot = cursorMs !== null && isMinuteTimeframe(timeframe);

  // Latest-mode data flows through `live` — LivePage owns the single
  // useLiveSeries call site. useSpot hooks in spot mode sit dormant when
  // cursorMs is null, no extra fetches.
  const { ob, broker } = live;
  const latestOrderbook = useMemo(() => latestOrderbookSnapshot(ob), [ob]);
  const latestBrokerSeries = useMemo(() => aggregateBrokerSeries(broker), [broker]);
  const latestBrokerTs =
    broker.length > 0 ? (broker[broker.length - 1].t_ms as number) : Date.now();

  // Spot-mode data (dormant when cursorMs null).
  const spotTimeframe: MinuteTimeframe | null =
    timeframe && isMinuteTimeframe(timeframe) ? timeframe : null;
  const spotOrderbook = useLiveOrderbookAtCursor({ code: stockCode, timeframe: spotTimeframe });
  const spotBrokers = useLiveBrokersAtCursor({ code: stockCode, timeframe: spotTimeframe });
  const investorTrendEstimate = useLiveInvestorTrendEstimate(stockCode);

  // Axis for Auction Mask in spot mode.
  const axis = useLiveAxisStore((s) => s.axis);
  const maskRatio = useAuctionMaskActive(axis, isSpot ? cursorMs : null);

  // Branch on spot vs latest.
  const spotSnap = spotOrderbook?.snapshot ?? null;
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
      isSpot && spotSnap === null && spotTimeframe !== null && cursorMs !== null
        ? orderbookSnapshotAtCursor(ob, cursorMs, TIMEFRAME_TO_MS[spotTimeframe as Timeframe])
        : null,
    [isSpot, spotSnap, spotTimeframe, cursorMs, ob],
  );
  const orderbookForCard = isSpot ? (spotSnap ?? bufferSnap) : latestOrderbook;
  const brokerSeriesForCard = isSpot
    ? spotBrokers
    : (broker.length === 0 ? undefined : latestBrokerSeries);
  const brokerCursorMs = isSpot ? (cursorMs ?? latestBrokerTs) : latestBrokerTs;
  const activeVolumeDistributionDate = isSpot && cursorMs !== null
    ? realMsToYyyymmdd(cursorMs)
    : (activeBundle?.segments[activeBundle.segments.length - 1]?.date ?? todayKst ?? null);
  const activeVolumeDistributionCandles = useMemo(() => {
    if (!activeBundle || !activeVolumeDistributionDate) return [];
    return activeBundle.candles.filter((candle) => realMsToYyyymmdd(candle.ts_ms) === activeVolumeDistributionDate);
  }, [activeBundle, activeVolumeDistributionDate]);
  const persistedVolumeDistributions = activeBundle?.volume_distributions ?? [];
  const liveDistributionTrades = useMemo(
    () => live.trade.flatMap((snapshot) =>
      snapshot.trades.map((trade) => ({
        t_ms: trade.t_ms ?? snapshot.t_ms,
        price: trade.price ?? NaN,
        qty: trade.qty,
        side: trade.side,
      })),
    ),
    [live.trade],
  );
  const todayContinuousBeforeMs = useMemo(() => {
    if (!activeBundle || !todayKst) return null;
    const todaySegment = activeBundle.segments.find((segment) => segment.date === todayKst);
    if (!todaySegment) return null;
    return firstTrailingSinglePriceBookMs(ob, todaySegment.session_close_ms);
  }, [activeBundle, todayKst, ob]);
  const recomputedTodayVolumeDistribution = useMemo(() => {
    if (
      !volumeDistributionEnabled ||
      !stockCode ||
      !todayKst ||
      !isMinuteTimeframe(timeframe) ||
      !activeBundle
    ) {
      return null;
    }
    const todaySegment = activeBundle.segments.find((segment) => segment.date === todayKst);
    if (!todaySegment) return null;
    const todayCandles = activeBundle.candles.filter((candle) => realMsToYyyymmdd(candle.ts_ms) === todayKst);
    if (todayCandles.length === 0) return null;
    return computeContinuousTradeVolumeDistribution({
      date: todayKst,
      candles: todayCandles,
      trades: liveDistributionTrades,
      rangeCount: volumeDistributionRangeCount,
      segment: todaySegment,
      continuousBeforeMs: todayContinuousBeforeMs,
    });
  }, [
    volumeDistributionEnabled,
    stockCode,
    todayKst,
    timeframe,
    activeBundle,
    liveDistributionTrades,
    volumeDistributionRangeCount,
    todayContinuousBeforeMs,
  ]);
  const activeVolumeDistribution = useMemo(() => {
    return selectVolumeDistributionProfile({
      enabled: volumeDistributionEnabled,
      date: activeVolumeDistributionDate,
      todayKst,
      rangeCount: volumeDistributionRangeCount,
      persistedProfiles: persistedVolumeDistributions,
      recomputedToday: recomputedTodayVolumeDistribution,
      liveTrades: liveDistributionTrades,
      continuousBeforeMs: todayContinuousBeforeMs,
    });
  }, [
    volumeDistributionEnabled,
    activeVolumeDistributionDate,
    todayKst,
    volumeDistributionRangeCount,
    recomputedTodayVolumeDistribution,
    persistedVolumeDistributions,
    liveDistributionTrades,
    todayContinuousBeforeMs,
  ]);
  const cutoffVolumeDistribution = useVolumeDistributionCutoffProfile({
    enabled: volumeDistributionEnabled && volumeDistributionHoverCutoffEnabled && isSpot,
    code: stockCode,
    timeframe: spotTimeframe,
    date: activeVolumeDistributionDate,
    cursorMs,
    todayKst,
    rangeCount: volumeDistributionRangeCount,
    finalProfile: activeVolumeDistribution,
    priceRange: null,
    liveTrades: liveDistributionTrades,
    candles: activeVolumeDistributionCandles,
    segment: activeBundle?.segments.find((segment) => segment.date === activeVolumeDistributionDate) ?? null,
  });
  const activeVolumeDistributionClosePoints = useMemo(() => {
    return volumeDistributionClosePoints({
      date: activeVolumeDistributionDate,
      candles: activeVolumeDistributionCandles,
    });
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
              <OrderbookTable snapshot={orderbookForCard} />
              <TotalQtyBar snapshot={orderbookForCard} maskRatio={maskRatio} />
            </>
          }
          volumeDistribution={
            <VolumeDistributionCard
              profile={cutoffVolumeDistribution}
              cursorMs={isSpot ? cursorMs : brokerCursorMs}
              closePoints={activeVolumeDistributionClosePoints}
              color={volumeDistributionColor}
              maxColor={volumeDistributionMaxColor}
            />
          }
          program={
            <ProgramTradeSummaryCard
              series={programTrade}
              cursorMs={isSpot ? cursorMs : null}
            />
          }
          brokers={
            <BrokerTrajectoryTable series={brokerSeriesForCard} cursorMs={brokerCursorMs} />
          }
          investor={<InvestorTrendEstimateCard query={investorTrendEstimate} />}
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
