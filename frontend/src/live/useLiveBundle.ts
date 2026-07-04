import { useEffect, useMemo, useRef } from 'react';
import type { LiveSeriesData } from '../api/liveSeries';
import { useLiveSettings } from '../api/liveSettings';
import { useLivePastCandles } from '../api/livePastCandles';
import { useLivePastDailyCandles } from '../api/livePastDailyCandles';
import { useLivePastInvestorNet } from '../api/livePastInvestorNet';
import { useScreenerDailyCandles } from '../api/screenerDailyCandles';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import type { LiveVenueOption } from '../state/liveVenue';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { useCandleDataPreferenceStore } from '../state/candleDataPreference';
import {
  kisRestWarningIndicatesUnavailable,
  useKisRestModeStore,
} from '../state/kisRestMode';
import {
  TIMEFRAME_TO_MS,
  type Timeframe,
  type RangeBundle,
  type Candle,
  type InvestorNetPoint,
  type SourceName,
} from '../api/types';
import { buildChartBundle, createIncrementalHogaSeriesBuilder, filterProgramTradeForCandles, type HogaSeries } from './buildLiveBundle';
import type { LiveDataWarning } from './liveDataWarnings';
import type { TradeSnapshot } from './bucketHogaSeries';
import { aggregateCandles, aggregateCalendar } from './aggregateCandles';
import { mergeCandlesByPriority } from './candleSourceMerge';
import {
  regularSessionOpenMs,
  regularSessionCloseMs,
  realMsToYyyymmdd,
  subtractDaysKst,
  initialHistoricalDaysFor,
  earliestAllowedMinuteDate,
} from './liveDateTime';
import {
  effectiveSessionBoundsByDate,
  liveVenueAllowsKrxTradeOverlay,
  liveVenueSessionBoundsMs,
  liveVenueUsesExtendedMinuteWindow,
} from './liveVenuePolicy';
import { buildLivePriceLevelHits, mergePriceLevelHits } from './priceLevelHits';

function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function kisBarToCandle(b: { t_ms: number; open: number; high: number; low: number; close: number; volume: number }): Candle {
  return {
    ts_ms: b.t_ms,
    open: b.open,
    close: b.close,
    high: b.high,
    low: b.low,
    vol_a: b.volume,
    vol_b: 0,
  };
}

function candleVolume(c: Candle): number {
  return (Number.isFinite(c.vol_a) ? c.vol_a : 0) + (Number.isFinite(c.vol_b) ? c.vol_b : 0);
}

function candleDateSet(candles: readonly Candle[]): Set<string> {
  return new Set(candles.map((c) => realMsToYyyymmdd(c.ts_ms)));
}

function keepRegularSessionCandles<T extends { t_ms: number }>(candles: readonly T[]): T[] {
  return candles.filter((c) => {
    const date = realMsToYyyymmdd(c.t_ms);
    return c.t_ms >= regularSessionOpenMs(date) && c.t_ms <= regularSessionCloseMs(date);
  });
}

function segmentSourceByDate(bundle: RangeBundle | null | undefined, date: string): SourceName | undefined {
  return bundle?.segments.find((s) => s.date === date)?.source;
}

function bucketStartMs(tMs: number, bucketMs: number): number {
  return Math.floor(tMs / bucketMs) * bucketMs;
}

function candlePriceRange(candles: readonly Candle[], startMs: number, endMs: number): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (candle.ts_ms < startMs || candle.ts_ms > endMs) continue;
    if (Number.isFinite(candle.low)) min = Math.min(min, candle.low);
    if (Number.isFinite(candle.high)) max = Math.max(max, candle.high);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export function overlayLiveTradesOnCandles(
  candles: readonly Candle[],
  trades: readonly TradeSnapshot[],
  bucketMs: number,
  venue: LiveVenueOption = 'KRX',
): Candle[] {
  if (candles.length === 0 || bucketMs <= 0) return [...candles];
  const out = candles.map((c) => ({ ...c }));
  const lastBase = candles[candles.length - 1];
  const lastBaseBucket = bucketStartMs(lastBase.ts_ms, bucketMs);
  const byBucket = new Map<number, Array<{ price: number; qty: number; tMs: number }>>();

  for (const snapshot of trades) {
    for (const ev of snapshot.trades) {
      const tMs = ev.t_ms ?? snapshot.t_ms;
      if (
        typeof ev.side !== 'number' ||
        typeof ev.price !== 'number' ||
        typeof ev.qty !== 'number' ||
        !Number.isFinite(tMs) ||
        !Number.isFinite(ev.price) ||
        !Number.isFinite(ev.qty) ||
        ev.qty <= 0 ||
        !liveVenueAllowsKrxTradeOverlay(venue, tMs)
      ) {
        continue;
      }
      const bucket = bucketStartMs(tMs, bucketMs);
      if (bucket < lastBaseBucket) continue;
      const bucketTrades = byBucket.get(bucket) ?? [];
      bucketTrades.push({ price: ev.price, qty: ev.qty, tMs });
      byBucket.set(bucket, bucketTrades);
    }
  }

  for (const [bucket, bucketTrades] of Array.from(byBucket.entries()).sort((a, b) => a[0] - b[0])) {
    bucketTrades.sort((a, b) => a.tMs - b.tMs);
    const lastTrade = bucketTrades[bucketTrades.length - 1];
    const tradeHigh = Math.max(...bucketTrades.map((t) => t.price));
    const tradeLow = Math.min(...bucketTrades.map((t) => t.price));
    const tradeQty = bucketTrades.reduce((sum, t) => sum + t.qty, 0);
    const last = out[out.length - 1];
    if (bucket === last.ts_ms) {
      last.high = Math.max(last.high, tradeHigh);
      last.low = Math.min(last.low, tradeLow);
      last.close = lastTrade.price;
      last.vol_a += tradeQty;
    } else if (bucket > last.ts_ms) {
      out.push({
        ts_ms: bucket,
        open: last.close,
        high: tradeHigh,
        low: tradeLow,
        close: lastTrade.price,
        vol_a: tradeQty,
        vol_b: 0,
      });
    }
  }

  return out;
}

export interface UseLiveBundleResult {
  /** Full bundle = stable chart side + live hoga overlay. Consumed by hoga
   * panes (ratio/quoteTotals/fillStrength), LiveStatusBar, LiveSidebar. New ref
   * on every SSE tick. */
  bundle: RangeBundle | null;
  /** Chart side only (candles + segments + investor), STABLE across SSE ticks.
   * Consumed by the candle/volume panes + axis + candle overlays so a tick
   * doesn't churn the candle path (2026-06-09 bundle-split, Phase A). Shares
   * `bundle`'s segments/candles refs (bundle spreads it). */
  chartBundle: RangeBundle | null;
  /** Hoga indicator panes only (quote totals / ratio / fill strength). Stable
   * across the slower full sidecar range so those panes can paint from
   * `mode=hoga` without being re-keyed when volume-distribution sidecars land. */
  hogaBundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** 좌측 팬 한 스텝이 진행 중(placeholderData+isFetching). false-edge = 스텝 settle.
   * LiveChartRoot 진행 루프가 이 falling edge에 반응해 다음 스텝을 dispatch한다. */
  isExtending: boolean;
  /** 활성 타임프레임 경로(분봉=past-candles, D/W/M=past-daily-candles)의 fetch 경고.
   * 백엔드가 KIS rate-limit 등으로 일부/전체 날짜를 못 받으면 채운다. LiveChartRoot가
   * 빈칸 문구 전환 + 부분 로딩 칩에 쓴다(2026-06-09). 무경고면 빈 배열. */
  pastDataWarnings: LiveDataWarning[];
}

type UseLiveBundleOptions = {
  investorNetEnabled?: boolean;
  venue?: LiveVenueOption;
};

export type LiveRangeRequestPlan = {
  code: string | null;
  from: string | null;
  to: string | null;
  timeframe: Timeframe | null;
  todayKst: string | null;
  options: {
    brokerLateEntriesEnabled: boolean;
    brokerLateEntryStartHHMM: number | null;
    volumeDistributionBins: number | null;
    tradeVolumePocBins: number | null;
    volumeDistributionPriceRange: { min: number; max: number } | null;
  };
};

export function planLiveRangeRequest(args: {
  code: string | null;
  timeframe: LiveTimeframe;
  todayKstYyyymmdd: string;
  historicalFromDate: string | null;
  tradeVolumePocEnabled: boolean;
  brokerLateEntryEnabled: boolean;
  brokerLateEntryStartHHMM: number;
  volumeDistributionEnabled: boolean;
  volumeDistributionRangeCount: number;
  volumeDistributionPriceRange: { min: number; max: number } | null;
}): LiveRangeRequestPlan {
  const isMinute = isMinuteTimeframe(args.timeframe);
  const seedFrom = args.historicalFromDate
    ?? subtractDaysKst(args.todayKstYyyymmdd, initialHistoricalDaysFor(args.timeframe));
  const minutePastFrom = laterDate(seedFrom, earliestAllowedMinuteDate(args.todayKstYyyymmdd));
  const enableMinute = !!(args.code && isMinute && minutePastFrom <= args.todayKstYyyymmdd);
  return {
    code: enableMinute ? args.code : null,
    from: enableMinute ? minutePastFrom : null,
    to: enableMinute ? args.todayKstYyyymmdd : null,
    timeframe: enableMinute ? (args.timeframe as Timeframe) : null,
    todayKst: enableMinute ? args.todayKstYyyymmdd : null,
    options: {
      brokerLateEntriesEnabled: args.brokerLateEntryEnabled,
      brokerLateEntryStartHHMM: args.brokerLateEntryEnabled ? args.brokerLateEntryStartHHMM : null,
      volumeDistributionBins: args.volumeDistributionEnabled ? args.volumeDistributionRangeCount : null,
      tradeVolumePocBins: args.tradeVolumePocEnabled ? args.volumeDistributionRangeCount : null,
      volumeDistributionPriceRange: args.volumeDistributionEnabled ? args.volumeDistributionPriceRange : null,
    },
  };
}

/** Orchestrate live SSE + KIS past-candles + /api/range hoga indicators into a
 * single RangeBundle for LiveChartRoot. ADR-0040 — KIS candles are the single
 * candle source via the dedicated `/api/live/past-candles` endpoint.
 *
 * ADR-0048: D/W/M timeframes route through `/api/live/past-daily-candles`
 * (direct daily backfill) instead of aggregating from 1m bars. Only the minute
 * branch is subject to the 250-day clamp; the daily branch has no clamp.
 */
export function useLiveBundle(
  code: string | null,
  timeframe: LiveTimeframe,
  todayKstYyyymmdd: string,
  live: LiveSeriesData,
  options: UseLiveBundleOptions = {},
): UseLiveBundleResult {
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const brokerLateEntryEnabled = useLivePageStore((s) => s.brokerLateEntryEnabled);
  const brokerLateEntryStartHHMM = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const sourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const candleDataPreference = useCandleDataPreferenceStore((s) => s.candleDataPreference);
  const { data: liveSettings } = useLiveSettings();
  const kisRestBypassEnabled = liveSettings?.kis_rest_bypass_enabled ?? false;
  const notifyKisRestFailure = useKisRestModeStore((s) => s.notifyFailure);
  const venue = options.venue ?? 'KRX';
  const preferHogaplayCandles = candleDataPreference === 'hogaplay_first';
  const preferScreenerDailyCandles = candleDataPreference === 'auto' || candleDataPreference === 'screener_daily_first';

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // 250-day clamp at the bundle layer so /api/range's 90-day cap and
  // /api/live/past-candles' 250-day cap can stay independent. Applies to
  // the minute path only — the daily endpoint has no equivalent cap.
  const seedFrom = historicalFromDate ?? subtractDaysKst(todayKstYyyymmdd, initialHistoricalDaysFor(timeframe));
  const earliestAllowedMinute = earliestAllowedMinuteDate(todayKstYyyymmdd);
  const minutePastFrom = laterDate(seedFrom, earliestAllowedMinute);
  // Includes today so post-promote disk data (hogaplay/snapshots.parquet,
  // ADR-0037 v2 layout) feeds today's hoga indicators. Before this, today's
  // quote_ratio/fill_strength came only from the in-memory SSE buffer, which
  // is volatile across backend restarts. buildLiveBundle's pastHasTodaySegment
  // check + the t > pastMaxQrT incremental filter already handle the dedup
  // with the SSE tail (buildLiveBundle.ts:67, 72).
  const minutePastTo = todayKstYyyymmdd;

  // Minute-only gate: both /api/range (hoga indicators) and
  // /api/live/past-candles fire on the same condition.
  const enableMinute = !!(code && isMinute && minutePastFrom <= minutePastTo && !kisRestBypassEnabled);
  const pastCandlesQuery = useLivePastCandles(
    enableMinute ? code : null,
    enableMinute ? minutePastFrom : null,
    enableMinute ? minutePastTo : null,
    venue,
  );

  // KIS daily past-candles — only enabled for D/W/M timeframes (ADR-0048).
  const enableDaily = !!(code && !isMinute && !kisRestBypassEnabled);
  const dailyPastFrom = seedFrom;
  const dailyPastTo = todayKstYyyymmdd;
  const pastDailyCandlesQuery = useLivePastDailyCandles(
    enableDaily ? code : null,
    enableDaily ? dailyPastFrom : null,
    enableDaily ? dailyPastTo : null,
    venue,
  );
  const screenerDailyCandlesQuery = useScreenerDailyCandles(
    enableDaily ? code : null,
    enableDaily ? dailyPastFrom : null,
    enableDaily ? dailyPastTo : null,
  );

  // Investor net-buy (foreign/institution) — 'D' (일봉) ONLY. KIS
  // investor-trade-by-stock-daily (FHPTJ04160001) walks back the requested
  // [from, to] range by date cursor. ADR-0055.
  // Why daily-only, not all calendar frames: investor points are daily-anchored
  // (09:00 KST), but W/M aggregate candles into week/month segments, so most
  // daily points would fall outside axis.contains and render a near-empty pane.
  // Optional pane data: if no investor pane is visible, do not fetch it or let
  // its later response churn the D chart bundle after the candles are revealed.
  const enableInvestor = !!(code && timeframe === 'D' && options.investorNetEnabled === true);
  const investorQuery = useLivePastInvestorNet(
    enableInvestor ? code : null,
    enableInvestor ? dailyPastFrom : null,
    enableInvestor ? dailyPastTo : null,
  );
  const investorPoints = useMemo<InvestorNetPoint[]>(
    () => (enableInvestor ? investorQuery.data?.points ?? [] : []),
    [enableInvestor, investorQuery.data],
  );

  useEffect(() => {
    const warnings = isMinute
      ? pastCandlesQuery.data?.data_warnings ?? []
      : pastDailyCandlesQuery.data?.data_warnings ?? [];
    if (warnings.some(kisRestWarningIndicatesUnavailable)) {
      notifyKisRestFailure();
    }
  }, [
    isMinute,
    notifyKisRestFailure,
    pastCandlesQuery.data?.data_warnings,
    pastDailyCandlesQuery.data?.data_warnings,
  ]);

  const candleFallbackNeeded = !!(code && (
    (kisRestBypassEnabled && (isMinute || timeframe === 'D')) ||
    (preferHogaplayCandles && (isMinute || timeframe === 'D')) ||
    (isMinute
      ? pastCandlesQuery.data != null && pastCandlesQuery.data.data_warnings.length > 0
      : timeframe === 'D' &&
        pastDailyCandlesQuery.data != null &&
        (pastDailyCandlesQuery.data.data_warnings.length > 0 || pastDailyCandlesQuery.data.candles.length === 0))
  ));
  const candleFallbackOptions = useMemo(
    () => ({
      mode: 'full' as const,
      brokerLateEntriesEnabled: false,
      brokerLateEntryStartHHMM: null,
      volumeDistributionBins: null,
      tradeVolumePocBins: null,
      volumeDistributionPriceRange: null,
    }),
    [],
  );
  const candleFallback = useRange(
    candleFallbackNeeded ? code : null,
    candleFallbackNeeded ? (isMinute ? minutePastFrom : dailyPastFrom) : null,
    candleFallbackNeeded ? (isMinute ? minutePastTo : dailyPastTo) : null,
    candleFallbackNeeded ? (isMinute ? (timeframe as Timeframe) : '1m') : null,
    undefined,
    candleFallbackNeeded ? todayKstYyyymmdd : null,
    candleFallbackOptions,
    preferHogaplayCandles ? 'hogaplay_first' : undefined,
  );
  const hogaplayCandleFallbackNeeded = candleFallbackNeeded && !preferHogaplayCandles && sourcePreference !== 'hogaplay_first';
  const hogaplayCandleFallback = useRange(
    hogaplayCandleFallbackNeeded ? code : null,
    hogaplayCandleFallbackNeeded ? (isMinute ? minutePastFrom : dailyPastFrom) : null,
    hogaplayCandleFallbackNeeded ? (isMinute ? minutePastTo : dailyPastTo) : null,
    hogaplayCandleFallbackNeeded ? (isMinute ? (timeframe as Timeframe) : '1m') : null,
    undefined,
    hogaplayCandleFallbackNeeded ? todayKstYyyymmdd : null,
    candleFallbackOptions,
    'hogaplay_first',
  );

  const kisCandles = useMemo<Candle[]>(() => {
    const selectedRangeFallback = mergeCandlesByPriority(
      candleFallback.data?.candles ?? [],
      hogaplayCandleFallback.data?.candles ?? [],
    );
    if (isMinute) {
      const raw = kisRestBypassEnabled ? [] : pastCandlesQuery.data?.candles ?? [];
      if (raw.length === 0) return selectedRangeFallback;
      // Minute timeframes: epoch-floor bucket via aggregateCandles (also dedupes
      // within-bucket duplicates from pre-f63ed15 KIS cache files).
      const bars = aggregateCandles(raw, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000);
      const apiCandles = bars.map(kisBarToCandle);
      return preferHogaplayCandles
        ? mergeCandlesByPriority(selectedRangeFallback, apiCandles)
        : mergeCandlesByPriority(apiCandles, selectedRangeFallback);
    }
    // D/W/M: bars come from the daily endpoint. For 'D' the call is
    // identity-ish (one bucket per bar); for 'W'/'M' aggregateCalendar groups
    // by ISO week / calendar month using the bar's first 1m bar t_ms so
    // axis.contains admits it inside that Segment.
    const raw = kisRestBypassEnabled ? [] : pastDailyCandlesQuery.data?.candles ?? [];
    const screenerRaw = screenerDailyCandlesQuery.data?.candles ?? [];
    const fallbackRaw = selectedRangeFallback.map((c) => ({
      t_ms: c.ts_ms,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: candleVolume(c),
    }));
    const fallbackInput = timeframe === 'D' ? keepRegularSessionCandles(fallbackRaw) : fallbackRaw;
    const fallbackBars = fallbackInput.length === 0
      ? []
      : aggregateCalendar(fallbackInput, timeframe as 'D' | 'W' | 'M');
    const fallback = fallbackBars.map(kisBarToCandle);
    const screenerBars = screenerRaw.length === 0
      ? []
      : timeframe === 'D'
        ? screenerRaw
        : aggregateCalendar(screenerRaw, timeframe as 'W' | 'M');
    const screenerCandles = screenerBars.map(kisBarToCandle);
    const bars = raw.length === 0 ? [] : timeframe === 'D' ? raw : aggregateCalendar(raw, timeframe as 'W' | 'M');
    const apiCandles = bars.map(kisBarToCandle);
    if (preferHogaplayCandles) {
      return mergeCandlesByPriority(
        fallback,
        mergeCandlesByPriority(screenerCandles, apiCandles),
      );
    }
    if (preferScreenerDailyCandles) {
      return mergeCandlesByPriority(
        screenerCandles,
        mergeCandlesByPriority(apiCandles, fallback),
      );
    }
    return mergeCandlesByPriority(
      apiCandles,
      mergeCandlesByPriority(screenerCandles, fallback),
    );
  }, [isMinute, timeframe, preferHogaplayCandles, preferScreenerDailyCandles, pastCandlesQuery.data, pastDailyCandlesQuery.data, screenerDailyCandlesQuery.data, candleFallback.data, hogaplayCandleFallback.data]);
  const candleSourceByDate = useMemo(() => {
    const primaryDates = isMinute
      ? new Set((pastCandlesQuery.data?.candles ?? []).map((c) => realMsToYyyymmdd(c.t_ms)))
      : new Set((pastDailyCandlesQuery.data?.candles ?? []).map((c) => realMsToYyyymmdd(c.t_ms)));
    const screenerDates = isMinute
      ? new Set<string>()
      : new Set((screenerDailyCandlesQuery.data?.candles ?? []).map((c) => realMsToYyyymmdd(c.t_ms)));
    const selectedFallbackDates = candleDateSet(candleFallback.data?.candles ?? []);
    const sourceByDate = new Map<string, SourceName>();

    for (const date of screenerDates) {
      if (preferHogaplayCandles && selectedFallbackDates.has(date)) continue;
      if (!preferScreenerDailyCandles && primaryDates.has(date)) continue;
      sourceByDate.set(date, 'screener_daily');
    }

    for (const date of selectedFallbackDates) {
      if (!preferHogaplayCandles && (primaryDates.has(date) || screenerDates.has(date))) continue;
      const source = segmentSourceByDate(candleFallback.data, date);
      if (source) sourceByDate.set(date, source);
    }

    for (const date of candleDateSet(hogaplayCandleFallback.data?.candles ?? [])) {
      if (primaryDates.has(date) || screenerDates.has(date) || selectedFallbackDates.has(date)) continue;
      sourceByDate.set(date, 'hogaplay');
    }

    return sourceByDate.size > 0 ? sourceByDate : undefined;
  }, [isMinute, preferHogaplayCandles, preferScreenerDailyCandles, pastCandlesQuery.data, pastDailyCandlesQuery.data, screenerDailyCandlesQuery.data, candleFallback.data, hogaplayCandleFallback.data]);
  const volumeDistributionPriceRange = useMemo(
    () =>
      isMinute && volumeDistributionEnabled
        ? candlePriceRange(kisCandles, regularSessionOpenMs(todayKstYyyymmdd), regularSessionCloseMs(todayKstYyyymmdd))
        : null,
    [isMinute, volumeDistributionEnabled, kisCandles, todayKstYyyymmdd],
  );
  const rangePlan = planLiveRangeRequest({
    code,
    timeframe,
    todayKstYyyymmdd,
    historicalFromDate,
    tradeVolumePocEnabled,
    brokerLateEntryEnabled,
    brokerLateEntryStartHHMM,
    volumeDistributionEnabled,
    volumeDistributionRangeCount,
    volumeDistributionPriceRange,
  });
  const hogaRangeOptions = useMemo(
    () => ({ mode: 'hoga' as const }),
    [],
  );
  const pastHoga = useRange(
    rangePlan.code,
    rangePlan.from,
    rangePlan.to,
    rangePlan.timeframe,
    undefined,
    rangePlan.todayKst,
    hogaRangeOptions,
  );
  const sidecarRangeOptions = useMemo(
    () => ({
      mode: 'sidecar' as const,
      ...rangePlan.options,
      // KIS candles arrive on a separate fast path, but today's promoted
      // trades can exist before a matching candles.parquet. The sidecar needs
      // the KIS candle low/high grid to build the dense 10-bin distribution
      // instead of making the sidebar fall back to the short live trade tail.
      volumeDistributionPriceRange: rangePlan.options.volumeDistributionPriceRange,
    }),
    [rangePlan.options],
  );
  const pastSidecars = useRange(
    rangePlan.code,
    rangePlan.from,
    rangePlan.to,
    rangePlan.timeframe,
    undefined,
    // /live's minutePastTo is always today (line 83), so this enables the
    // 5-min refetch that advances pastMaxQrT (review C1 — seam hole). The gate
    // lives in rangeFreshnessOptions: past-only callers (no todayKst) stay
    // frozen. A periodic refetch keeps the same query key → no placeholderData
    // swap → does not set isExtending, so today's right edge is untouched.
    rangePlan.todayKst,
    sidecarRangeOptions,
  );
  const liveCandles = useMemo<Candle[]>(
    () => (isMinute ? overlayLiveTradesOnCandles(kisCandles, live.trade, bucketMs, venue) : kisCandles),
    [isMinute, kisCandles, live.trade, bucketMs, venue],
  );

  const defaultKrxSession = useMemo(
    () =>
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) },
    [live.initial, todayKstYyyymmdd],
  );
  const effectiveSessionByDate = useMemo(
    () => effectiveSessionBoundsByDate(pastCandlesQuery.data?.effective_sessions),
    [pastCandlesQuery.data?.effective_sessions],
  );
  // Chart session follows the selected KIS Venue for minute candles. HOGA/WS
  // side remains KRX-only, so buildHogaSeries keeps the default KRX bounds.
  const todayChartSession = useMemo(
    () => {
      if (!isMinute) return defaultKrxSession;
      const effective = effectiveSessionByDate.get(todayKstYyyymmdd);
      if (effective) return effective;
      return liveVenueUsesExtendedMinuteWindow(venue)
        ? liveVenueSessionBoundsMs(todayKstYyyymmdd, venue)
        : defaultKrxSession;
    },
    [defaultKrxSession, effectiveSessionByDate, isMinute, todayKstYyyymmdd, venue],
  );
  const sessionBoundsForDate = useMemo(
    () =>
      isMinute
        ? (yyyymmdd: string) =>
            effectiveSessionByDate.get(yyyymmdd) ??
            (liveVenueUsesExtendedMinuteWindow(venue)
              ? liveVenueSessionBoundsMs(yyyymmdd, venue)
              : {
                  open_ms: regularSessionOpenMs(yyyymmdd),
                  close_ms: regularSessionCloseMs(yyyymmdd),
                })
        : undefined,
    [effectiveSessionByDate, isMinute, venue],
  );

  // CHART side (candles + segments + investor). Deps deliberately EXCLUDE the
  // ob/trade arrays — the only today-signal input is the `hasTodayObSignal`
  // boolean, which flips false→true once on the first push and then stays put.
  // So an SSE tick (new live.ob ref, same length>0) does NOT re-run this memo →
  // `chartBundle` ref stays STABLE across ticks → the candle/volume panes + axis
  // never re-setData on a tick (2026-06-09 bundle-split design, Phase A).
  const hasTodayObSignal = isMinute && live.ob.length > 0;
  // Last content-distinct segments array — see the stabilization block below.
  const prevSegmentsRef = useRef<RangeBundle['segments'] | null>(null);
  const computedChartBundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;
    const built = buildChartBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession: todayChartSession,
      pastBundle: pastHoga.data ?? null,
      kisCandles: liveCandles,
      candleSourceByDate,
      bucketMs,
      hasTodayObSignal,
      investorPoints,
      sessionBoundsForDate,
    });
    const sidecarSource = pastSidecars.data ?? null;
    if (sidecarSource) {
      built.ask_peaks = sidecarSource.ask_peaks ?? [];
      built.bid_peaks = sidecarSource.bid_peaks ?? [];
      built.broker_late_entries = sidecarSource.broker_late_entries ?? [];
      built.trade_volume_pocs = sidecarSource.trade_volume_pocs ?? [];
      built.volume_distributions = sidecarSource.volume_distributions ?? [];
      built.program_trade = filterProgramTradeForCandles(sidecarSource.program_trade, liveCandles);
    }

    // Segments-identity stabilization (eng review C1): buildChartBundle allocates
    // a fresh `segments` array each call even when no trading date changed.
    // LiveChartRoot memoises the VirtualAxis on this array's REFERENCE and the
    // KST behavior's `cacheKey` bumps its label-cache generation on axis
    // identity — so reuse the previous array when content-equal; it only changes
    // identity on a genuine mapping change (new date appended / leftward-pan
    // prepend).
    const prev = prevSegmentsRef.current;
    const sameSegments =
      prev !== null &&
      prev.length === built.segments.length &&
      built.segments.every(
        (s, i) =>
          s.date === prev[i].date &&
          s.session_open_ms === prev[i].session_open_ms &&
          s.session_close_ms === prev[i].session_close_ms &&
          s.source === prev[i].source,
      );
    if (sameSegments) {
      built.segments = prev;
    } else {
      prevSegmentsRef.current = built.segments;
    }

    return built;
  }, [code, todayKstYyyymmdd, todayChartSession, pastHoga.data, pastSidecars.data, liveCandles, candleSourceByDate, bucketMs, hasTodayObSignal, investorPoints, sessionBoundsForDate]);

  // HOGA side (quote_ratio / fill_strength). Deps INCLUDE ob/trade — this is the
  // ONLY half that rebuilds on an SSE tick.
  const hogaSeriesBuilderRef = useRef<ReturnType<typeof createIncrementalHogaSeriesBuilder> | null>(null);
  if (hogaSeriesBuilderRef.current === null) {
    hogaSeriesBuilderRef.current = createIncrementalHogaSeriesBuilder();
  }
  const hogaSeries = useMemo<HogaSeries>(
    () =>
      hogaSeriesBuilderRef.current!({
        todaySession: defaultKrxSession,
        pastBundle: pastHoga.data ?? null,
        sseOb: isMinute ? live.ob : [],
        sseTrade: isMinute ? live.trade : [],
        bucketMs,
      }),
    [defaultKrxSession, pastHoga.data, isMinute, live.ob, live.trade, bucketMs],
  );
  const livePriceLevelHits = useMemo(
    () => (isMinute ? buildLivePriceLevelHits(liveCandles, todayKstYyyymmdd) : []),
    [isMinute, liveCandles, todayKstYyyymmdd],
  );

  // Atomize the historical-prepend across the two independent past sources.
  // A leftward pan changes `historicalFromDate`, which re-keys BOTH past
  // queries (candles via /api/live/past-candles, hoga via /api/range). They
  // resolve in SEPARATE commits, so without gating the bundle would rebuild
  // twice — once with new candles + stale hoga, then with both — landing the
  // prepend in two paints. That splits LiveChartRoot's viewport shift across two
  // commits (a visible ~60ms jump-then-correct flicker) and makes the first
  // shift see a candles-only union (wrong inserted-index count). All three
  // queries keep the previous response as `placeholderData` during a same-code
  // re-key, so `isPlaceholderData` is true for exactly the window where one
  // source has the new range and the other does not. Hold the last fully-settled
  // bundle until BOTH are fresh, so the prepend swaps in ONE commit. SSE-only
  // and periodic-refetch updates do NOT set isPlaceholderData, so today's live
  // ticks are not gated.
  // Atomize ONLY a genuine historical extension (a leftward pan), keyed on
  // historicalFromDate != null. A pan re-keys BOTH past queries (candles via
  // /api/live/past-candles, hoga via /api/range), which resolve in SEPARATE
  // commits; without gating, the bundle rebuilds twice (new candles + stale
  // hoga, then both), splitting LiveChartRoot's viewport shift across two paints
  // and feeding the first shift a candles-only union (wrong inserted-index
  // count). Hold the last fully-settled bundle until BOTH sources are fresh so
  // the prepend swaps in ONE commit.
  //
  // The historicalFromDate gate is what scopes this to extensions: setActiveCode
  // and setCandleTimeframe reset it to null, so a code OR timeframe switch — both
  // of which ALSO re-key the past queries (useRange embeds bucketMs;
  // useLivePastCandles' from embeds initialHistoricalDaysFor(timeframe)) — is NOT
  // gated and falls straight through to computedBundle, instead of stalling on
  // the previous code/timeframe's bundle. SSE / periodic refetches never set
  // isPlaceholderData, so today's live ticks are not gated either.
  //
  // `&& isFetching` releases the hold if a re-keyed query goes
  // pending-but-NOT-fetching (paused/offline, or `enabled` flipped mid-flight),
  // which would otherwise freeze the bundle with no fetch in flight; a settled
  // error drops isPlaceholderData on its own (status leaves 'pending'). The hold
  // lasts as long as the slower past-fetch (bounded by the global retry:1),
  // pausing today's right edge — acceptable because the user is panned into
  // history, not watching the live edge.
  const extending = historicalFromDate != null && (isMinute
    ? (pastHoga.isPlaceholderData && pastHoga.isFetching) ||
      (pastCandlesQuery.isPlaceholderData && pastCandlesQuery.isFetching)
    : (pastDailyCandlesQuery.isPlaceholderData && pastDailyCandlesQuery.isFetching) ||
      (screenerDailyCandlesQuery.isPlaceholderData && screenerDailyCandlesQuery.isFetching));
  // The gate holds the CHART side (candle/segment prepend atomicity is what it
  // protects — the viewport shift is candle-index-based). The hoga overlay
  // follows via the spread below; its points don't drive the viewport, so
  // letting them settle a beat later than the held chart is harmless.
  const lastSettledChartRef = useRef<RangeBundle | null>(null);
  const chartBundle = extending && lastSettledChartRef.current
    ? lastSettledChartRef.current
    : computedChartBundle;
  useEffect(() => {
    if (!extending) lastSettledChartRef.current = computedChartBundle;
  }, [extending, computedChartBundle]);

  // Full bundle = stable chart side + live hoga overlay. Spreading chartBundle
  // shares its segments/candles refs, so the VirtualAxis stays single-build and
  // hoga panes (which read bundle.segments / bundle.bucket_ms in fillStrength)
  // see the same coordinate system as the candle path.
  const bundle = useMemo<RangeBundle | null>(
    () =>
      chartBundle
        ? {
            ...chartBundle,
            quote_ratio: hogaSeries.quote_ratio,
            fill_strength: hogaSeries.fill_strength,
            price_level_hits: mergePriceLevelHits(chartBundle.price_level_hits, livePriceLevelHits),
          }
        : null,
    [chartBundle, hogaSeries, livePriceLevelHits],
  );
  const hogaBundle = useMemo<RangeBundle | null>(
    () =>
      chartBundle
        ? {
            ...chartBundle,
            quote_ratio: hogaSeries.quote_ratio,
            fill_strength: hogaSeries.fill_strength,
            broker_late_entries: brokerLateEntryEnabled ? chartBundle.broker_late_entries : [],
            program_trade: { points: [] },
          }
        : null,
    [
      chartBundle?.code,
      chartBundle?.from_date,
      chartBundle?.to_date,
      chartBundle?.bucket_ms,
      chartBundle?.segments,
      hogaSeries,
      brokerLateEntryEnabled,
      brokerLateEntryEnabled ? chartBundle?.broker_late_entries : null,
    ],
  );

  // Clamp is a minute-path concern only; the daily endpoint has no 250d cap.
  const clampEngaged = isMinute
    && historicalFromDate != null
    && historicalFromDate <= earliestAllowedMinute;

  // 활성 타임프레임 경로의 fetch 경고만 노출 — 분봉은 past-candles, D/W/M은
  // past-daily-candles. (다른 경로 쿼리는 enabled=false라 data가 없거나 스테일.)
  const pastDataWarnings: LiveDataWarning[] = isMinute
    ? pastCandlesQuery.data?.data_warnings ?? []
    : [
        ...(pastDailyCandlesQuery.data?.data_warnings ?? []),
        ...(screenerDailyCandlesQuery.data?.data_warnings ?? []),
      ];

  return {
    bundle,
    chartBundle,
    hogaBundle,
    isLoading: live.isLoading || pastHoga.isLoading || pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading || screenerDailyCandlesQuery.isLoading || (candleFallbackNeeded && candleFallback.isLoading) || (hogaplayCandleFallbackNeeded && hogaplayCandleFallback.isLoading),
    error: live.error ?? pastHoga.error ?? pastCandlesQuery.error ?? pastDailyCandlesQuery.error ?? screenerDailyCandlesQuery.error ?? pastSidecars.error ?? candleFallback.error ?? hogaplayCandleFallback.error ?? null,
    clampEngaged,
    isPastCandlesLoading: pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading || screenerDailyCandlesQuery.isLoading || (candleFallbackNeeded && candleFallback.isLoading) || (hogaplayCandleFallbackNeeded && hogaplayCandleFallback.isLoading) || (enableInvestor && investorQuery.isLoading),
    isExtending: extending,
    pastDataWarnings,
  };
}
