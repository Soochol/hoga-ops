import type { Candle, PriceLevelHit } from '../api/types';
import { realMsToYyyymmdd } from './liveDateTime';

type Candidate = Pick<PriceLevelHit, 'price' | 'kind' | 'direction' | 'pct'>;

function krxStockTickSize(price: number): number {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

function ceilKrxStockTick(price: number): number {
  let candidate = Math.trunc(price);
  candidate =
    Math.ceil(candidate / krxStockTickSize(candidate)) *
    krxStockTickSize(candidate);
  while (candidate < price) candidate += krxStockTickSize(candidate);
  return candidate;
}

function floorKrxStockTick(price: number): number {
  let candidate = Math.trunc(price);
  candidate =
    Math.floor(candidate / krxStockTickSize(candidate)) *
    krxStockTickSize(candidate);
  while (candidate > price) candidate -= krxStockTickSize(candidate);
  return candidate;
}

function priceCandidates(viBaseOpen: number | null, limitBasePrevClose: number | null): Candidate[] {
  const out: Candidate[] = [];
  if (viBaseOpen != null && Number.isFinite(viBaseOpen) && viBaseOpen > 0) {
    out.push(
      { price: ceilKrxStockTick(viBaseOpen * 1.1), kind: 'vi', direction: 'upper', pct: 10 },
      { price: ceilKrxStockTick(viBaseOpen * 1.2), kind: 'vi', direction: 'upper', pct: 20 },
      { price: floorKrxStockTick(viBaseOpen * 0.9), kind: 'vi', direction: 'lower', pct: 10 },
      { price: floorKrxStockTick(viBaseOpen * 0.8), kind: 'vi', direction: 'lower', pct: 20 },
    );
  }
  if (limitBasePrevClose != null && Number.isFinite(limitBasePrevClose) && limitBasePrevClose > 0) {
    out.push(
      { price: floorKrxStockTick(limitBasePrevClose * 1.3), kind: 'limit', direction: 'upper', pct: 30 },
      { price: ceilKrxStockTick(limitBasePrevClose * 0.7), kind: 'limit', direction: 'lower', pct: 30 },
    );
  }
  return out;
}

function findTodayOpen(candles: readonly Candle[], todayKst: string): number | null {
  const today = candles
    .filter((c) => realMsToYyyymmdd(c.ts_ms) === todayKst)
    .sort((a, b) => a.ts_ms - b.ts_ms);
  return today.length > 0 ? today[0].open : null;
}

function findPreviousClose(candles: readonly Candle[], todayKst: string): number | null {
  const prev = candles
    .filter((c) => realMsToYyyymmdd(c.ts_ms) < todayKst)
    .sort((a, b) => a.ts_ms - b.ts_ms);
  return prev.length > 0 ? prev[prev.length - 1].close : null;
}

function hitKey(hit: PriceLevelHit): string {
  return `${hit.date}|${hit.price}|${hit.kind}|${hit.direction}|${hit.pct}`;
}

export function buildLivePriceLevelHits(
  candles: readonly Candle[],
  todayKst: string,
): PriceLevelHit[] {
  const candidates = priceCandidates(findTodayOpen(candles, todayKst), findPreviousClose(candles, todayKst));
  if (candidates.length === 0 || candles.length === 0) return [];
  const todayCandles = candles
    .filter((c) => realMsToYyyymmdd(c.ts_ms) === todayKst)
    .sort((a, b) => a.ts_ms - b.ts_ms);

  const hits: PriceLevelHit[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const candle = todayCandles.find((c) =>
      candidate.direction === 'upper' ? c.high >= candidate.price : c.low <= candidate.price,
    );
    if (!candle) continue;
    const hit: PriceLevelHit = {
      date: todayKst,
      t_ms: candle.ts_ms,
      ...candidate,
    };
    const key = hitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  return hits;
}

export function mergePriceLevelHits(
  backendHits: readonly PriceLevelHit[] = [],
  liveHits: readonly PriceLevelHit[] = [],
): PriceLevelHit[] {
  const out: PriceLevelHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...backendHits, ...liveHits]) {
    const key = hitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}
