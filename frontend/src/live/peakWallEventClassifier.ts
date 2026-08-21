import type { AskPeakCandidate } from '../api/types';
import { isIndicatorEligibleBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';

export type PeakWallEvent = AskPeakCandidate;

export type PeakWallTouchTick = {
  price: number;
  t_ms: number;
};

export type PeakWallClassification = {
  /** 동일분 터치 벽 — 그 벽이 관측된 1분 안에서 체결이 그 가격을 친 것(ADR-0156). */
  touched: AskPeakCandidate[];
  /** 터치와 무관한 전체 벽 — 「보이는 영역 최대벽」의 원천. */
  all: AskPeakCandidate[];
};

const EMIT_LIMIT = 3;

/** 터치 판정 창(ADR-0156). 백엔드 `snapshots.ONE_MINUTE_MS` 와 **같은 값이어야 한다** —
 *  오늘(클라이언트 계산)과 과거일(백엔드 seed)이 같은 규칙으로 분류되는 것이 그 ADR 의
 *  요구이고, 어긋나면 오늘이 과거일로 넘어가는 순간 판정이 조용히 바뀐다. */
export const TOUCH_WINDOW_MS = 60_000;

export function touchWindowOf(tMs: number): number {
  return Math.floor(tMs / TOUCH_WINDOW_MS);
}

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
  sessionOpenMs: number,
): AskPeakCandidate[] {
  const bySnapshot = new Map<string, AskPeakCandidate>();
  for (const orderbook of orderbooks) {
    if (!isIndicatorEligibleBook(orderbook, sessionOpenMs)) continue;
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

/**
 * 분 → 그 분 체결가의 극값(ask=max, bid=min).
 *
 * ADR-0084 시절엔 "이벤트 이후 아무 때나" 라는 전역 시간 관계라 터치를 시각순으로
 * 정렬하고 suffix 극값 + 이진탐색을 써야 했다. ADR-0156 이 관계를 분 안으로 닫으면서
 * **순서가 무의미해졌다** — 맵 하나면 되고, 터치가 역순으로 도착해도 답이 같다.
 */
export function touchExtremeByWindow(
  touches: readonly PeakWallTouchTick[],
  side: 'ask' | 'bid',
): Map<number, number> {
  const out = new Map<number, number>();
  const isAsk = side === 'ask';
  for (const touch of touches) {
    const window = touchWindowOf(touch.t_ms);
    const current = out.get(window);
    if (current === undefined) {
      out.set(window, touch.price);
    } else {
      out.set(window, isAsk ? Math.max(current, touch.price) : Math.min(current, touch.price));
    }
  }
  return out;
}

export function isWallTouched(
  event: PeakWallEvent,
  extremeByWindow: ReadonlyMap<number, number>,
  side: 'ask' | 'bid',
): boolean {
  const extreme = extremeByWindow.get(touchWindowOf(event.t_ms));
  if (extreme === undefined) return false;
  return side === 'ask' ? extreme >= event.price : extreme <= event.price;
}

function classifyWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
  side: 'ask' | 'bid',
): PeakWallClassification {
  const dedupedEvents = uniquePeakCandidates(events);
  const extremeByWindow = touchExtremeByWindow(touches, side);
  return {
    touched: rankPeakCandidates(
      dedupedEvents.filter((event) => isWallTouched(event, extremeByWindow, side)),
    ),
    all: rankPeakCandidates(dedupedEvents),
  };
}

export function classifyAskWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
): PeakWallClassification {
  return classifyWallEvents(events, touches, 'ask');
}

export function classifyBidWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
): PeakWallClassification {
  return classifyWallEvents(events, touches, 'bid');
}
