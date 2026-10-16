import { useMemo, useRef } from 'react';
import type { Candle, DayVolumeDistribution, RangeSegment, TradeVolumePocWire } from '../api/types';
import { firstTrailingSinglePriceBookMs, mergeVolumeDistributionTail } from './continuousTradeVolumeDistribution';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import {
  computeCandleVolumePocs,
  computeTradeVolumePoc,
  IncrementalTradeVolumePoc,
  priceRangeFromCandles,
  type TradeVolumePoc,
} from './tradeVolumePoc';
import { isStockIndicatorBreak } from '../util/stockSessions';
import { tradeVolumePocFromWire } from './tradeVolumePocWire';
import { useWindowIndicator } from './workspace/windowView';

const EMPTY_DISTRIBUTIONS: readonly DayVolumeDistribution[] = [];

const LEGACY_TRADE_VOLUME_POC_BAND_PCT = 0.005;

function matchesBandPct(value: number, target: number): boolean {
  return Math.abs(value - target) < 1e-9;
}

function seedByDate(
  seeds: readonly TradeVolumePocWire[],
): Map<string, TradeVolumePocWire> {
  const out = new Map<string, TradeVolumePocWire>();
  for (const seed of seeds) {
    const current = out.get(seed.date);
    if (
      !current ||
      (
        !matchesBandPct(current.band_pct, LEGACY_TRADE_VOLUME_POC_BAND_PCT) &&
        matchesBandPct(seed.band_pct, LEGACY_TRADE_VOLUME_POC_BAND_PCT)
      )
    ) {
      out.set(seed.date, seed);
    }
  }
  return out;
}

export function useTradeVolumePocs(
  trades: readonly TradeSnapshot[],
  seeds: readonly TradeVolumePocWire[],
  todayKst: string,
  code: string | null,
  candles: readonly Candle[] = [],
  segments: readonly RangeSegment[] = [],
  orderbooks: readonly ObSnapshot[] = [],
  venue: string = "KRX",
  distributions: readonly DayVolumeDistribution[] = EMPTY_DISTRIBUTIONS,
): TradeVolumePoc[] {
  const rangeCount = useWindowIndicator((s) => s.volumeDistributionRangeCount);
  // 당일 distribution POC 증분 누적기 — 훅 수명 동안 인스턴스 고정(useDayAskPeaks 선례).
  const todayPocRef = useRef<IncrementalTradeVolumePoc | null>(null);
  if (todayPocRef.current === null) todayPocRef.current = new IncrementalTradeVolumePoc();
  const seedsByDate = useMemo(() => seedByDate(seeds), [seeds]);
  const todaySegment = useMemo(
    () => segments.find(segment => segment.date === todayKst), [segments, todayKst],
  );
  const todayCandles = useMemo(() => todaySegment
    ? candles.filter(c => c.ts_ms >= todaySegment.session_open_ms && c.ts_ms < todaySegment.session_close_ms
      && !isStockIndicatorBreak(c.ts_ms, venue))
    : [], [candles, todaySegment, venue]);
  const todayLive = useMemo(() => {
    const todayContinuousBeforeMs = todaySegment
      ? firstTrailingSinglePriceBookMs(orderbooks, todaySegment.session_close_ms, todaySegment.session_open_ms, venue)
      : null;
    const baseline = distributions.find(p => p.date === todayKst && p.range_count === rangeCount
      && p.last_trade_ms != null
      && p.session_open_ms === todaySegment?.session_open_ms && p.session_close_ms === todaySegment?.session_close_ms
      && p.bins.every(b => b.qty === 0 || b.first_trade_ms != null));
    if (baseline) {
      const profile = mergeVolumeDistributionTail(baseline,
        trades.flatMap(snapshot => snapshot.trades.map(trade => ({ ...trade, price: trade.price ?? Number.NaN, t_ms: trade.t_ms ?? snapshot.t_ms }))),
        null, todayContinuousBeforeMs, venue);
      let best = -1;
      for (let i = 0; i < profile.bins.length; i++) {
        if (profile.bins[i].qty > 0 && (best < 0 || profile.bins[i].qty > profile.bins[best].qty)) best = i;
      }
      if (best < 0) return null;
      const bin = profile.bins[best];
      return { date: todayKst, centerPrice: Math.floor((bin.price_low + bin.price_high) / 2),
        lowPrice: bin.price_low, highPrice: bin.price_high, qty: bin.qty,
        t_ms: bin.first_trade_ms!, bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT };
    }
    // distribution 분기(candles+segment+유효 rangeCount)만 증분 누적기로 라우팅한다.
    // computeTradeVolumePoc 의 그 분기와 동일 조건 — 나머지(무효 rangeCount·todaySegment
    // 부재)는 byPrice map 폴백이라 원래 호출을 그대로 둔다(behavior parity).
    const distributionRange = todaySegment
      && Number.isInteger(rangeCount) && (rangeCount as number) > 0
      ? priceRangeFromCandles(todayCandles)
      : null;
    if (todaySegment && distributionRange) {
      return todayPocRef.current!.update(trades, {
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        rangeMin: distributionRange.min,
        rangeMax: distributionRange.max,
        rangeCount: rangeCount as number,
        venue,
        sessionOpenMs: todaySegment.session_open_ms,
        sessionCloseMs: todaySegment.session_close_ms,
        continuousBeforeMs: todayContinuousBeforeMs,
      });
    } else if (todaySegment && Number.isInteger(rangeCount) && (rangeCount as number) > 0) {
      // 유효 rangeCount 지만 range 가 null(당일 캔들 없음) → distribution 은 null.
      return null;
    } else {
      return computeTradeVolumePoc(trades, {
        venue,
        segment: todaySegment ?? undefined,
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        continuousBeforeMs: todayContinuousBeforeMs,
      });
    }
  }, [trades, todayKst, code, todaySegment, todayCandles, rangeCount, orderbooks, venue, distributions]);
  const hasTodayLive = todayLive !== null;
  const fallbackSegments = useMemo(() => segments.filter(segment =>
    !seedsByDate.has(segment.date) && !(segment.date === todayKst && hasTodayLive)),
  [segments, seedsByDate, todayKst, hasTodayLive]);
  const candleFallbacks = useMemo(() => computeCandleVolumePocs(candles, fallbackSegments,
    { bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT, rangeCount, venue }),
  [candles, fallbackSegments, rangeCount, venue]);
  return useMemo(() => {
    const out = Array.from(seedsByDate.values()).filter(p => p.date !== todayKst).map(tradeVolumePocFromWire);
    const seenDates = new Set(out.map(p => p.date));
    const todaySeed = seedsByDate.get(todayKst);
    if (todayLive) out.push(todayLive);
    else if (todaySeed) out.push(tradeVolumePocFromWire(todaySeed));
    if (todayLive || todaySeed) seenDates.add(todayKst);
    for (const poc of candleFallbacks) {
      if (seenDates.has(poc.date)) continue;
      out.push(poc);
      seenDates.add(poc.date);
    }
    return out;
  }, [seedsByDate, todayKst, todayLive, candleFallbacks]);
}
