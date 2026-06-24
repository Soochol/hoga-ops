import type { Candle, PriceLevelHit } from '../api/types';
import { realMsToYyyymmdd } from './liveDateTime';

type Candidate = Pick<PriceLevelHit, 'price' | 'kind' | 'direction' | 'pct'>;
const VI_COOLING_MS = 120_000;

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

function ceilKrxStockTickRatio(price: number, numerator: number, denominator: number): number {
  return ceilKrxStockTick(Math.ceil((price * numerator) / denominator));
}

function floorKrxStockTickRatio(price: number, numerator: number, denominator: number): number {
  return floorKrxStockTick(Math.floor((price * numerator) / denominator));
}

function limitPriceCandidates(limitBasePrevClose: number | null): Candidate[] {
  const out: Candidate[] = [];
  if (limitBasePrevClose != null && Number.isFinite(limitBasePrevClose) && limitBasePrevClose > 0) {
    out.push(
      { price: floorKrxStockTickRatio(limitBasePrevClose, 13, 10), kind: 'limit', direction: 'upper', pct: 30 },
      { price: ceilKrxStockTickRatio(limitBasePrevClose, 7, 10), kind: 'limit', direction: 'lower', pct: 30 },
    );
  }
  return out;
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

function firstTouch(
  candles: readonly Candle[],
  candidate: Candidate,
  minTsMs: number | null = null,
): Candle | null {
  return candles.find((c) => {
    if (minTsMs != null && c.ts_ms < minTsMs) return false;
    return candidate.direction === 'upper' ? c.high >= candidate.price : c.low <= candidate.price;
  }) ?? null;
}

function appendHit(
  hits: PriceLevelHit[],
  seen: Set<string>,
  date: string,
  candle: Candle,
  candidate: Candidate,
): void {
  const hit: PriceLevelHit = {
    date,
    t_ms: candle.ts_ms,
    ...candidate,
  };
  const key = hitKey(hit);
  if (seen.has(key)) return;
  seen.add(key);
  hits.push(hit);
}

function appendViHits(
  hits: PriceLevelHit[],
  seen: Set<string>,
  todayCandles: readonly Candle[],
  todayKst: string,
  viBaseOpen: number | null,
  direction: 'upper' | 'lower',
): void {
  if (viBaseOpen == null || !Number.isFinite(viBaseOpen) || viBaseOpen <= 0) return;

  const firstPrice = direction === 'upper'
    ? ceilKrxStockTickRatio(viBaseOpen, 11, 10)
    : floorKrxStockTickRatio(viBaseOpen, 9, 10);
  const firstCandidate: Candidate = { price: firstPrice, kind: 'vi', direction, pct: 10 };
  const first = firstTouch(todayCandles, firstCandidate);
  if (!first) return;
  appendHit(hits, seen, todayKst, first, firstCandidate);

  const reopen = todayCandles.find((c) => c.ts_ms >= first.ts_ms + VI_COOLING_MS);
  if (!reopen) return;
  const secondPrice = direction === 'upper'
    ? ceilKrxStockTickRatio(reopen.open, 11, 10)
    : floorKrxStockTickRatio(reopen.open, 9, 10);
  const secondCandidate: Candidate = { price: secondPrice, kind: 'vi', direction, pct: 20 };
  const second = firstTouch(todayCandles, secondCandidate, reopen.ts_ms);
  if (!second) return;
  appendHit(hits, seen, todayKst, second, secondCandidate);
}

export function buildLivePriceLevelHits(
  candles: readonly Candle[],
  todayKst: string,
): PriceLevelHit[] {
  if (candles.length === 0) return [];
  const todayCandles = candles
    .filter((c) => realMsToYyyymmdd(c.ts_ms) === todayKst)
    .sort((a, b) => a.ts_ms - b.ts_ms);
  if (todayCandles.length === 0) return [];

  const hits: PriceLevelHit[] = [];
  const seen = new Set<string>();
  const todayOpen = todayCandles[0].open;
  appendViHits(hits, seen, todayCandles, todayKst, todayOpen, 'upper');
  appendViHits(hits, seen, todayCandles, todayKst, todayOpen, 'lower');

  for (const candidate of limitPriceCandidates(findPreviousClose(candles, todayKst))) {
    const candle = firstTouch(todayCandles, candidate);
    if (!candle) continue;
    appendHit(hits, seen, todayKst, candle, candidate);
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
