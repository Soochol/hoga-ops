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

/**
 * KST 날짜가 `yyyymmdd` 이상인 첫 candle 의 index (candles 는 `ts_ms` 오름차순).
 *
 * 종전엔 `candles.filter((c) => realMsToYyyymmdd(c.ts_ms) === todayKst)` 로 **전체를
 * 훑었고**, 그것도 오늘 캔들 찾기 · 직전 종가 찾기 두 번 했다. `realMsToYyyymmdd` 는
 * 캔들마다 `Date` 를 새로 만드는데, 이 함수는 SSE 틱(150ms)마다 불린다 — 90일
 * (35,100 캔들) 실측 8.15ms/틱이 여기 들었다. 이진 탐색이면 날짜 변환이 O(log n) 회로
 * 줄고, 오늘 구간은 뒤에서 앞으로 이어져 있으므로 그 뒤만 훑으면 된다.
 *
 * 전제: `candles` 는 `ts_ms` 오름차순 — 리포 전역 불변식이다(`volume.ts` 의
 * `lowerBoundCandle`, `CandleTooltip` 의 인덱스 맵이 이미 같은 전제 위에 있다).
 * 그래서 종전의 `.sort()` 두 개도 무의미했고(이미 정렬된 입력) 함께 걷어낸다.
 */
function lowerBoundByKstDate(candles: readonly Candle[], yyyymmdd: string): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (realMsToYyyymmdd(candles[mid].ts_ms) < yyyymmdd) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
  // 오늘 구간의 시작 = 날짜가 todayKst 이상인 첫 index. 그 **직전**이 곧 직전 거래일의
  // 마지막 캔들이라, 종전에 따로 전체를 훑던 `findPreviousClose` 가 여기로 접힌다.
  const start = lowerBoundByKstDate(candles, todayKst);
  let end = start;
  while (end < candles.length && realMsToYyyymmdd(candles[end].ts_ms) === todayKst) end += 1;
  const todayCandles = candles.slice(start, end);
  if (todayCandles.length === 0) return [];
  const previousClose = start > 0 ? candles[start - 1].close : null;

  const hits: PriceLevelHit[] = [];
  const seen = new Set<string>();
  const todayOpen = todayCandles[0].open;
  appendViHits(hits, seen, todayCandles, todayKst, todayOpen, 'upper');
  appendViHits(hits, seen, todayCandles, todayKst, todayOpen, 'lower');

  for (const candidate of limitPriceCandidates(previousClose)) {
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
