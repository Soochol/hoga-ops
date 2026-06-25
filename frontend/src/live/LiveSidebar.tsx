import { useMemo } from 'react';
import CursorSidebar from '../sidebar/CursorSidebar';
import { InvestorTrendEstimateCard } from '../sidebar/InvestorTrendEstimateCard';
import OrderbookTable from '../sidebar/OrderbookTable';
import BrokerTrajectoryTable from '../sidebar/BrokerTrajectoryTable';
import TotalQtyBar from '../sidebar/TotalQtyBar';
import { VolumeDistributionCard } from '../sidebar/VolumeDistributionCard';
import type { LiveSeriesData } from '../api/liveSeries';
import {
  aggregateBrokerSeries,
  latestOrderbookSnapshot,
  orderbookSnapshotAtCursor,
} from './liveSidebarAdapters';
import { TIMEFRAME_TO_MS, type DayVolumeDistribution, type RangeBundle, type Timeframe } from '../api/types';
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
import { realMsToYyyymmdd } from './liveDateTime';
import { computeContinuousTradeVolumeDistribution } from './continuousTradeVolumeDistribution';

interface Props {
  code: string | null;
  /** Owned by LivePage's single useLiveSeries call (ADR-0040 spirit). The
   * sidebar must NOT call useLiveSeries itself — that would open a second
   * SSE connection and a parallel buffer that drifts out of sync on HMR
   * re-mounts. */
  live: LiveSeriesData;
  bundle?: RangeBundle | null;
  todayKst?: string;
}

/**
 * Live Sidebar — two cards (10호가 / 거래원) wired to live data.
 *
 * Reuses the existing CursorSidebar layout shell from /replay so visual
 * parity is automatic. The data wiring differs:
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
function profileForDate(
  profiles: readonly DayVolumeDistribution[],
  date: string | null,
): DayVolumeDistribution | null {
  if (!date) return null;
  return profiles.find((profile) => profile.date === date) ?? null;
}

type VolumeDistributionTrade = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

function mergeVolumeDistributionDelta(
  profile: DayVolumeDistribution,
  trades: readonly VolumeDistributionTrade[],
): DayVolumeDistribution {
  if (profile.last_trade_ms == null || profile.bins.length === 0) return profile;
  const rangeCount = profile.bins.length;
  const rawBinWidth = (profile.price_max - profile.price_min) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  const bins = profile.bins.map((bin) => ({ ...bin }));
  let lastTradeMs = profile.last_trade_ms;

  for (const trade of trades) {
    if (trade.t_ms <= profile.last_trade_ms) continue;
    if (trade.t_ms < profile.session_open_ms || trade.t_ms >= profile.session_close_ms) continue;
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    if (!Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    if (trade.price < profile.price_min || trade.price > profile.price_max) continue;

    const idx = Math.max(
      0,
      Math.min(rangeCount - 1, Math.floor((trade.price - profile.price_min) / binWidth)),
    );
    bins[idx] = { ...bins[idx], qty: bins[idx].qty + trade.qty };
    lastTradeMs = Math.max(lastTradeMs, trade.t_ms);
  }

  return lastTradeMs === profile.last_trade_ms
    ? profile
    : { ...profile, bins, last_trade_ms: lastTradeMs };
}

export function LiveSidebar({ code, live, bundle = null, todayKst = '' }: Props) {
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const volumeDistributionColor = useLivePageStore((s) => s.volumeDistributionColor);
  const volumeDistributionMaxColor = useLivePageStore((s) => s.volumeDistributionMaxColor);
  const stockCode = code && !code.startsWith('index:') ? code : null;

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
  const activeBundle = bundle;

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
    if (todayCandles.length === 0 || liveDistributionTrades.length === 0) return null;
    return computeContinuousTradeVolumeDistribution({
      date: todayKst,
      candles: todayCandles,
      trades: liveDistributionTrades,
      rangeCount: volumeDistributionRangeCount,
      segment: todaySegment,
    });
  }, [volumeDistributionEnabled, stockCode, todayKst, timeframe, activeBundle, liveDistributionTrades, volumeDistributionRangeCount]);
  const activeVolumeDistribution = useMemo(() => {
    if (!volumeDistributionEnabled) return undefined;
    const persistedProfile = profileForDate(persistedVolumeDistributions, activeVolumeDistributionDate);
    if (persistedProfile) {
      return activeVolumeDistributionDate === todayKst
        ? mergeVolumeDistributionDelta(persistedProfile, liveDistributionTrades)
        : persistedProfile;
    }
    if (activeVolumeDistributionDate === todayKst) {
      return recomputedTodayVolumeDistribution;
    }
    return null;
  }, [
    volumeDistributionEnabled,
    activeVolumeDistributionDate,
    todayKst,
    recomputedTodayVolumeDistribution,
    persistedVolumeDistributions,
    liveDistributionTrades,
  ]);
  const activeVolumeDistributionClose = useMemo(() => {
    if (!activeBundle || !activeVolumeDistributionDate) return null;
    const candles = activeBundle.candles
      .filter((candle) => realMsToYyyymmdd(candle.ts_ms) === activeVolumeDistributionDate)
      .sort((a, b) => a.ts_ms - b.ts_ms);
    const last = candles[candles.length - 1];
    return last?.close ?? null;
  }, [activeBundle, activeVolumeDistributionDate]);

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
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
      }}
    >
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CursorSidebar
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
              profile={activeVolumeDistribution}
              cursorMs={isSpot ? cursorMs : brokerCursorMs}
              closePrice={activeVolumeDistributionClose}
              color={volumeDistributionColor}
              maxColor={volumeDistributionMaxColor}
            />
          }
          brokers={
            <BrokerTrajectoryTable series={brokerSeriesForCard} cursorMs={brokerCursorMs} />
          }
        />
        <InvestorTrendEstimateCard query={investorTrendEstimate} />
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
