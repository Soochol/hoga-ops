import type { Candle, PriceLevelHit } from '../api/types';
import type { TradeSnapshot } from './bucketHogaSeries';
import { realMsToYyyymmdd } from './liveDateTime';

type Candidate = Pick<PriceLevelHit, 'price' | 'kind' | 'direction' | 'pct'>;

function priceCandidates(viBaseOpen: number | null, limitBasePrevClose: number | null): Candidate[] {
  const out: Candidate[] = [];
  if (viBaseOpen != null && Number.isFinite(viBaseOpen) && viBaseOpen > 0) {
    out.push(
      { price: Math.round(viBaseOpen * 1.1), kind: 'vi', direction: 'upper', pct: 10 },
      { price: Math.round(viBaseOpen * 1.2), kind: 'vi', direction: 'upper', pct: 20 },
      { price: Math.round(viBaseOpen * 0.9), kind: 'vi', direction: 'lower', pct: 10 },
      { price: Math.round(viBaseOpen * 0.8), kind: 'vi', direction: 'lower', pct: 20 },
    );
  }
  if (limitBasePrevClose != null && Number.isFinite(limitBasePrevClose) && limitBasePrevClose > 0) {
    out.push(
      { price: Math.round(limitBasePrevClose * 1.3), kind: 'limit', direction: 'upper', pct: 30 },
      { price: Math.round(limitBasePrevClose * 0.7), kind: 'limit', direction: 'lower', pct: 30 },
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
  trades: readonly TradeSnapshot[],
  todayKst: string,
): PriceLevelHit[] {
  const candidates = priceCandidates(findTodayOpen(candles, todayKst), findPreviousClose(candles, todayKst));
  if (candidates.length === 0 || trades.length === 0) return [];

  const flatTrades = trades
    .flatMap((snapshot) =>
      snapshot.trades.map((ev) => ({
        tMs: ev.t_ms ?? snapshot.t_ms,
        price: ev.price,
        qty: ev.qty,
      })),
    )
    .filter(
      (ev): ev is { tMs: number; price: number; qty: number } =>
        Number.isFinite(ev.tMs) &&
        typeof ev.price === 'number' &&
        Number.isFinite(ev.price) &&
        typeof ev.qty === 'number' &&
        Number.isFinite(ev.qty) &&
        ev.qty > 0 &&
        realMsToYyyymmdd(ev.tMs) === todayKst,
    )
    .sort((a, b) => a.tMs - b.tMs);

  const hits: PriceLevelHit[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trade = flatTrades.find((ev) => Math.round(ev.price) === candidate.price);
    if (!trade) continue;
    const hit: PriceLevelHit = {
      date: todayKst,
      t_ms: trade.tMs,
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
