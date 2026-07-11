import { useMemo, useRef } from 'react';
import type { Candle, RangeSegment, TradeVolumePocWire } from '../api/types';
import { useLivePageStore } from '../state/livePage';
import { firstTrailingSinglePriceBookMs } from './continuousTradeVolumeDistribution';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import {
  computeCandleVolumePocs,
  computeTradeVolumePoc,
  IncrementalTradeVolumePoc,
  priceRangeFromCandles,
  type TradeVolumePoc,
} from './tradeVolumePoc';
import { tradeVolumePocFromWire } from './tradeVolumePocWire';

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
): TradeVolumePoc[] {
  const rangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  // 당일 distribution POC 증분 누적기 — 훅 수명 동안 인스턴스 고정(useDayAskPeaks 선례).
  const todayPocRef = useRef<IncrementalTradeVolumePoc | null>(null);
  if (todayPocRef.current === null) todayPocRef.current = new IncrementalTradeVolumePoc();
  const candleFallbacks = useMemo(
    () => computeCandleVolumePocs(
      candles,
      segments,
      { bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT, rangeCount },
    ),
    [candles, segments, rangeCount],
  );
  return useMemo(() => {
    const seedsByDate = seedByDate(seeds);
    const out = Array.from(seedsByDate.values()).filter((p) => p.date !== todayKst).map(tradeVolumePocFromWire);
    const seenDates = new Set(out.map((p) => p.date));
    const todaySegment = segments.find((segment) => segment.date === todayKst);
    const todayContinuousBeforeMs = todaySegment
      ? firstTrailingSinglePriceBookMs(orderbooks, todaySegment.session_close_ms)
      : null;
    const todayCandles = todaySegment
      ? candles.filter((candle) => candle.ts_ms >= todaySegment.session_open_ms && candle.ts_ms < todaySegment.session_close_ms)
      : [];
    // distribution 분기(candles+segment+유효 rangeCount)만 증분 누적기로 라우팅한다.
    // computeTradeVolumePoc 의 그 분기와 동일 조건 — 나머지(무효 rangeCount·todaySegment
    // 부재)는 byPrice map 폴백이라 원래 호출을 그대로 둔다(behavior parity).
    const distributionRange = todaySegment
      && Number.isInteger(rangeCount) && (rangeCount as number) > 0
      ? priceRangeFromCandles(todayCandles)
      : null;
    let todayLive: TradeVolumePoc | null;
    if (todaySegment && distributionRange) {
      todayLive = todayPocRef.current!.update(trades, {
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        rangeMin: distributionRange.min,
        rangeMax: distributionRange.max,
        rangeCount: rangeCount as number,
        sessionOpenMs: todaySegment.session_open_ms,
        sessionCloseMs: todaySegment.session_close_ms,
        continuousBeforeMs: todayContinuousBeforeMs,
      });
    } else if (todaySegment && Number.isInteger(rangeCount) && (rangeCount as number) > 0) {
      // 유효 rangeCount 지만 range 가 null(당일 캔들 없음) → distribution 은 null.
      todayLive = null;
    } else {
      todayLive = computeTradeVolumePoc(trades, {
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        continuousBeforeMs: todayContinuousBeforeMs,
      });
    }
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
  }, [trades, seeds, todayKst, code, candles, segments, rangeCount, candleFallbacks, orderbooks]);
}
