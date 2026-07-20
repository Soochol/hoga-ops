import type { QuoteRatioPoint, FillStrengthPoint, OrderbookLevel } from '../api/types';
import { quoteImbalance } from '../util/imbalance';
import { isAfterRegularOpen } from '../util/tradingDay';

/** One live OB snapshot as it crosses the SSE seam (SR-1). The chart reads
 * t_ms + total_*_qty; LiveSidebar reads asks/bids too (optional because the
 * minute-chart path only needs the totals). `kind` rides along from the
 * buffer entry. The index signature keeps it assignable from the structurally
 * untyped buffer (`Record<string, unknown>`) without an `as unknown as`. */
export interface ObSnapshot {
  t_ms: number;
  total_ask_qty: number;
  total_bid_qty: number;
  asks?: OrderbookLevel[];
  bids?: OrderbookLevel[];
  kind?: string;
  /** 이 스냅샷을 실어온 시장(#524 시분할). 백엔드 태그; 구백엔드는 부재(=KRX 해석). */
  venue?: 'KRX' | 'NXT';
  [field: string]: unknown;
}

export interface TradeEvent {
  t_ms?: number;
  price?: number;
  side: number; // KIS enum: -1 sell, 0 mid, 1 buy, 2 auction
  qty: number;
  /** 분류 출처 라벨. 표시 경로(WS raw)는 'kiwoom_ws'(키움 0B 원본 체결),
   *  저장 경로에서 되읽은 값은 'kis_ws_10s'(10초 집계, 동결 라벨). 소비자는
   *  값에 의존하지 않는다 — 계약을 타입에 드러내 둘 뿐이다. */
  side_source?: string;
}

export interface TradeSnapshot {
  t_ms: number;
  trades: TradeEvent[];
  kind?: string;
  /** 이 스냅샷을 실어온 시장(#524 시분할). 백엔드 태그; 구백엔드는 부재(=KRX 해석). */
  venue?: 'KRX' | 'NXT';
  [field: string]: unknown;
}

/** A live OB snapshot is a *continuous-trading book* iff both sides show depth
 * beyond level 3 (asks[3..] and bids[3..] qty > 0). The closing auction/VI can
 * collapse a side to exactly 3 levels. If neither asks nor bids rode along (minute-chart
 * totals-only path) we cannot tell structurally → treat as continuous so the
 * series falls back to legacy last-in-bucket (no spurious masking). */
export function isContinuousBook(s: ObSnapshot): boolean {
  const hasDeep = (lv: OrderbookLevel[] | undefined): boolean =>
    !!lv && lv.slice(3).some((l) => l.qty > 0);
  if (!s.asks && !s.bids) return true;
  return hasDeep(s.asks) && hasDeep(s.bids);
}

/** 호가 파생 지표(호가비·총잔량·히트맵·매도/매수 최대벽) 공용 '유효 스냅샷' 술어 (ADR-0062 v3).
 * 백엔드 `_book_indicator_eligible_sql`의 구조+개장 하한과 글자 그대로 같은 정의:
 * 연속거래 호가창(3호가 붕괴 아님, `isContinuousBook`) AND 정규장 개장(09:00) 이후
 * (`isAfterRegularOpen`). 마감 상한(`<= sessionClose` / `lastContinuousMs`)은 백엔드
 * session_close 대응으로 각 버킷 경계에서 따로 적용한다 — 미래 틱에 의존하는 이 상한만
 * 지표별로 두고, 미래 무관한 구조+개장은 이 한 술어로 통일한다(peak 래칫도 공유). */
export function isIndicatorEligibleBook(s: ObSnapshot): boolean {
  return isContinuousBook(s) && isAfterRegularOpen(s.t_ms);
}

/** Bucket label = floor(t_ms / bucketMs) * bucketMs (bucket start). Matches
 * `aggregateCandles.ts` convention so candle/volume/호가 align on the x-axis.
 *
 * Quote Totals: state — last snapshot in bucket wins (analogous to candle close).
 * FillStrength: flow — sum qty in bucket. Only side=1 (buy) and side=-1 (sell)
 * contribute. side=0 (mid, classifier fallback) and side=2 (auction) are
 * intentionally excluded — same semantics as ADR-0029's auction-window hide
 * and the replay viewer's existing FillStrength projector. */
export function bucketHogaSeries(
  ob: readonly ObSnapshot[],
  trade: readonly TradeSnapshot[],
  bucketMs: number,
  sessionCloseMs: number = Number.POSITIVE_INFINITY,
): { quoteRatioPoints: QuoteRatioPoint[]; fillStrengthPoints: FillStrengthPoint[] } {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);

  const obSorted = [...ob].sort((a, b) => a.t_ms - b.t_ms);

  // Structural closing-auction boundary (2026-06-03 spec). `lastContinuousMs` =
  // the last continuous-book snapshot at/before the session close; snapshots after
  // it are the closing auction. The `<= sessionCloseMs` bound is load-bearing — a
  // post-cross book re-expansion would otherwise push the boundary past the
  // auction. None found → +Infinity (no cutoff = every snapshot pre-auction =
  // legacy last-in-bucket).
  let lastContinuousMs = Number.NEGATIVE_INFINITY;
  for (const s of obSorted) {
    if (s.t_ms <= sessionCloseMs && isContinuousBook(s)) lastContinuousMs = s.t_ms;
  }
  if (lastContinuousMs === Number.NEGATIVE_INFINITY) {
    lastContinuousMs = Number.POSITIVE_INFINITY;
  }

  // Quote Totals — last *continuous-trading* snapshot in bucket. Straddle buckets
  // prefer the last pre-auction (<= lastContinuousMs) snapshot. A fully-auction
  // bucket (no pre-auction snapshot, e.g. the closing 15:21-15:30 buckets) emits
  // 0 instead of the auction book, so the closing-auction 3-level book never
  // enters the 호가비·총잔량 calculation regardless of the display Auction Mask
  // toggle (ADR-0062). The 0 point is kept so the mask / overlay band / day-
  // boundary connector handling stay intact. Mirrors query_bucketed_ratio's
  // CASE WHEN is_pre on the past-date path.
  // ADR-0062 v2/v3 (동시호가 배제 통일): 대표선정에 시간 상한(lastContinuousMs)뿐 아니라
  // 공용 술어 isIndicatorEligibleBook = per-snapshot isContinuousBook AND isAfterRegularOpen을
  // 요구한다 — **장중 VI 단일가 붕괴책**(구조)과 **개장 동시호가**(v3, 09:00 하한)를 대표·
  // Intra-Bar Max 누적에서 배제(백엔드 _book_indicator_eligible_sql·매도벽과 동일). VI-only·
  // 개장전 버킷은 아래 else의 0-센티넬로 방출되고, 연속거래가 섞인 버킷은 연속 스냅샷이
  // 대표가 된다. asks/bids 미동반(totals-only) 스냅샷은 isContinuousBook이 true라 기존
  // 폴백(붕괴 감지 불가 → 포함)이 유지된다(개장 하한은 여전히 적용).
  const quoteByBucket = new Map<number, QuoteRatioPoint>();
  const seenPre = new Set<number>();
  for (const s of obSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    if (s.t_ms <= lastContinuousMs && isIndicatorEligibleBook(s)) {
      // pre-auction: last continuous wins (close = bid_total/ask_total). Intra-Bar
      // Max fields accumulate over the SAME continuous-snapshot set (s.t_ms <=
      // lastContinuousMs) so 동시호가 is excluded identically and bid_max ≥ bid_total
      // holds by construction:
      //   bid_max/ask_max — independent per-side Math.max (peaks may be at different
      //     snapshots within the bucket, Q5).
      //   imb_max_bid/imb_max_ask — the (bid,ask) of the snapshot with the largest
      //     |quoteImbalance(bid,ask)| in the bucket; strict-`>` keeps the earliest on
      //     ties ("동률 시 가장 먼저").
      const prev = quoteByBucket.get(t);
      const bid_max = Math.max(prev?.bid_max ?? 0, s.total_bid_qty);
      const ask_max = Math.max(prev?.ask_max ?? 0, s.total_ask_qty);
      let imb_max_bid = prev?.imb_max_bid ?? 0;
      let imb_max_ask = prev?.imb_max_ask ?? 0;
      const curMag = Math.abs(quoteImbalance(s.total_bid_qty, s.total_ask_qty));
      const prevMag = prev ? Math.abs(quoteImbalance(imb_max_bid, imb_max_ask)) : -1;
      if (curMag > prevMag) {
        imb_max_bid = s.total_bid_qty;
        imb_max_ask = s.total_ask_qty;
      }
      quoteByBucket.set(t, {
        t,
        ask_total: s.total_ask_qty,
        bid_total: s.total_bid_qty,
        bid_max,
        ask_max,
        imb_max_bid,
        imb_max_ask,
      });
      seenPre.add(t);
    } else if (!seenPre.has(t)) {
      // fully-auction bucket: exclude the auction book (emit 0, keep the slot). All
      // Intra-Bar Max fields are 0 sentinels too (no continuous candidate).
      quoteByBucket.set(t, {
        t,
        ask_total: 0,
        bid_total: 0,
        bid_max: 0,
        ask_max: 0,
        imb_max_bid: 0,
        imb_max_ask: 0,
      });
    }
  }
  const quoteRatioPoints = Array.from(quoteByBucket.values()).sort((a, b) => a.t - b.t);

  // FillStrength — sum-in-bucket.
  const tradeSorted = [...trade].sort((a, b) => a.t_ms - b.t_ms);
  const fillByBucket = new Map<number, FillStrengthPoint>();
  for (const s of tradeSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    let bucket = fillByBucket.get(t);
    if (!bucket) {
      bucket = { t, buy_qty: 0, sell_qty: 0 };
      fillByBucket.set(t, bucket);
    }
    for (const ev of s.trades) {
      if (ev.side === 1) bucket.buy_qty += ev.qty;
      else if (ev.side === -1) bucket.sell_qty += ev.qty;
    }
  }
  const fillStrengthPoints = Array.from(fillByBucket.values()).sort((a, b) => a.t - b.t);

  return { quoteRatioPoints, fillStrengthPoints };
}
