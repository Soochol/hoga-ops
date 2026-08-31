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
  /** 미도달 벽 — 당일 체결 극값(ask=고가/bid=저가)이 가격으로 지배하지 못한 벽.
   *  판정이 하루 스코프라 극값 전진이 벽을 **소급 제거**한다(백엔드 unreached 계열의
   *  미러 — 클라이언트는 시드도 이 판정으로 재필터한다). 극값을 모르면(체결 0건)
   *  전부 미도달이다. */
  unreached: AskPeakCandidate[];
};

/** 당일 체결 극값 결합 — null 은 "모름"이고 어느 쪽이든 아는 값이 이긴다. */
export function combineDayExtreme(
  a: number | null,
  b: number | null,
  side: 'ask' | 'bid',
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return side === 'ask' ? Math.max(a, b) : Math.min(a, b);
}

/** 미도달 판정 — 극값이 가격을 지배하지 못했는가(ask: price > 고가, bid: price < 저가). */
export function isWallUnreached(
  price: number,
  dayExtreme: number | null,
  side: 'ask' | 'bid',
): boolean {
  if (dayExtreme === null) return true;
  return side === 'ask' ? price > dayExtreme : price < dayExtreme;
}

/** 오늘 캔들에서 당일 체결 극값을 근사한다(ask=최고 high, bid=최저 low) — 시간 컷오프
 *  판의 극값 원천. 캔들은 체결 파생이라 백엔드의 연속체결(side ±1) 정의와 동시호가
 *  경계에서 미세하게 다를 수 있다 — 컷오프 모드의 문서화된 근사다(백엔드 day_extreme
 *  은 "지금" 기준이라 과거 컷오프에 쓰면 미래 체결이 섞인다). */
export function dayExtremeFromCandles(
  candles: readonly { ts_ms: number; high: number; low: number }[],
  side: 'ask' | 'bid',
  fromMs: number,
  toMs: number,
): number | null {
  let extreme: number | null = null;
  for (const candle of candles) {
    if (candle.ts_ms < fromMs || candle.ts_ms > toMs) continue;
    const value = side === 'ask' ? candle.high : candle.low;
    if (!Number.isFinite(value)) continue;
    extreme = combineDayExtreme(extreme, value, side);
  }
  return extreme;
}

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
  backendDayExtreme: number | null,
): PeakWallClassification {
  const dedupedEvents = uniquePeakCandidates(events);
  const extremeByWindow = touchExtremeByWindow(touches, side);
  // 미도달의 극값 = 인자(백엔드 스냅샷/캔들 근사) ∪ 이 입력의 체결 극값 — 증분판
  // (IncrementalPeakWallSource)과 같은 결합이어야 배치·증분 동등성이 유지된다.
  let dayExtreme = backendDayExtreme;
  for (const touch of touches) {
    dayExtreme = combineDayExtreme(dayExtreme, touch.price, side);
  }
  return {
    touched: rankPeakCandidates(
      dedupedEvents.filter((event) => isWallTouched(event, extremeByWindow, side)),
    ),
    all: rankPeakCandidates(dedupedEvents),
    unreached: rankPeakCandidates(
      dedupedEvents.filter((event) => isWallUnreached(event.price, dayExtreme, side)),
    ),
  };
}

export function classifyAskWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
  backendDayExtreme: number | null = null,
): PeakWallClassification {
  return classifyWallEvents(events, touches, 'ask', backendDayExtreme);
}

export function classifyBidWallEvents(
  events: readonly PeakWallEvent[],
  touches: readonly PeakWallTouchTick[],
  backendDayExtreme: number | null = null,
): PeakWallClassification {
  return classifyWallEvents(events, touches, 'bid', backendDayExtreme);
}
