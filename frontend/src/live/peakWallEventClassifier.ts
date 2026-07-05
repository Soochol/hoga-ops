import type { AskPeakCandidate } from '../api/types';
import { isContinuousBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';
import { isAfterRegularOpen } from '../util/tradingDay';

export type PeakWallEvent = AskPeakCandidate;

export type PeakWallTouchTick = {
  price: number;
  t_ms: number;
};

export type PeakWallClassification = {
  postTouch: AskPeakCandidate[];
  postUntouched: AskPeakCandidate[];
  all: AskPeakCandidate[];
};

const EMIT_LIMIT = 3;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function candidateKey(candidate: AskPeakCandidate): string {
  return `${candidate.price}:${candidate.qty}:${candidate.t_ms}`;
}

function uniquePeakCandidates(candidates: readonly AskPeakCandidate[]): AskPeakCandidate[] {
  const out: AskPeakCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export function rankPeakCandidates(
  candidates: readonly AskPeakCandidate[],
  limit: number = EMIT_LIMIT,
): AskPeakCandidate[] {
  return uniquePeakCandidates(candidates)
    .slice()
    .sort((a, b) => b.qty - a.qty || a.t_ms - b.t_ms || a.price - b.price)
    .slice(0, limit);
}

export function toWallEventsFromOrderbooks(
  orderbooks: ReadonlyArray<ObSnapshot>,
  side: 'ask' | 'bid',
): AskPeakCandidate[] {
  const bySnapshot = new Map<string, AskPeakCandidate>();
  for (const orderbook of orderbooks) {
    if (!isContinuousBook(orderbook) || !isAfterRegularOpen(orderbook.t_ms)) continue;
    const levels = side === 'ask' ? orderbook.asks : orderbook.bids;
    if (!levels) continue;
    for (const level of levels) {
      if (!isFiniteNumber(level.price) || !isFiniteNumber(level.qty) || level.qty <= 0) continue;
      const key = `${level.price}:${orderbook.t_ms}`;
      const current = bySnapshot.get(key);
      if (!current || level.qty > current.qty) {
        bySnapshot.set(key, { price: level.price, qty: level.qty, t_ms: orderbook.t_ms });
      }
    }
  }
  return Array.from(bySnapshot.values());
}

export function toTouchTicksFromTrades(
  trades: ReadonlyArray<TradeSnapshot>,
): PeakWallTouchTick[] {
  const out: PeakWallTouchTick[] = [];
  for (const snapshot of trades) {
    for (const trade of snapshot.trades) {
      if ((trade.side !== 1 && trade.side !== -1) || !isFiniteNumber(trade.price)) continue;
      const tMs = isFiniteNumber(trade.t_ms) ? trade.t_ms : snapshot.t_ms;
      if (!isFiniteNumber(tMs) || tMs <= 0) continue;
      out.push({ price: trade.price, t_ms: tMs });
    }
  }
  return out;
}

function classifyWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
  isTouchedByPrice: (touchPrice: number, wallPrice: number) => boolean,
): PeakWallClassification {
  const dedupedEvents = uniquePeakCandidates(events);
  const postTouch = dedupedEvents.filter((event) =>
    touches.some((touch) => touch.t_ms >= event.t_ms && isTouchedByPrice(touch.price, event.price)),
  );
  const touchedKeys = new Set(postTouch.map(candidateKey));
  const postUntouched = dedupedEvents.filter((event) => !touchedKeys.has(candidateKey(event)));
  return {
    postTouch: rankPeakCandidates(postTouch),
    postUntouched: rankPeakCandidates(postUntouched),
    all: rankPeakCandidates(dedupedEvents),
  };
}

export function classifyAskWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
): PeakWallClassification {
  return classifyWallEvents(events, touches, (touchPrice, wallPrice) => touchPrice >= wallPrice);
}

export function classifyBidWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
): PeakWallClassification {
  return classifyWallEvents(events, touches, (touchPrice, wallPrice) => touchPrice <= wallPrice);
}
