import type { RangeBundle } from '../api/types';
import { isStaleLiveQuote, type LiveQuote } from '../api/liveQuotes';
import type { LiveVenueOption } from '../state/liveVenue';
import type { TradeSnapshot } from './bucketHogaSeries';
import { liveVenueAllowsTradeOverlay } from './liveVenuePolicy';

export type PriceLineColors = { up: string; down: string; neutral: string };
export type PriceLineModel = { price: number; color: string } | null;

/** fresh 체결가 TTL. WS 두절/체결 뜸 시 마지막 체결가에 얼어붙지 않고 quote(10s
 *  폴, closed 에도 마지막 시세 서빙)로 폴백하기 위한 상한. */
export const TRADE_PRICE_FRESH_MS = 60_000;

/**
 * live.trade 버퍼 끝에서 마지막 유효 체결가를 찾는다. venue 태그 불일치·TTL
 * 초과·유효 체결 없음 → null. 유효성 판정은 overlayLiveTradesOnCandles
 * (useLiveBundle.ts)와 동일 기준(price finite>0, qty>0, t_ms ?? snapshot.t_ms,
 * liveVenueAllowsTradeOverlay(selectedVenue, snapshot.venue, tMs)) — 라인과 캔들
 * 오버레이가 같은 체결을 보게 해 분봉에서 라인이 forming 캔들 close 에 정확히
 * 부착되도록 한다. 뒤에서부터 스캔하므로 O(마지막 스냅샷) 수준.
 */
export function freshLiveTradePrice(
  trades: readonly TradeSnapshot[],
  venue: LiveVenueOption,
  nowMs: number,
): number | null {
  for (let i = trades.length - 1; i >= 0; i--) {
    const snapshot = trades[i];
    for (let j = snapshot.trades.length - 1; j >= 0; j--) {
      const ev = snapshot.trades[j];
      const tMs = ev.t_ms ?? snapshot.t_ms;
      if (
        typeof ev.side !== 'number' ||
        typeof ev.price !== 'number' ||
        typeof ev.qty !== 'number' ||
        !Number.isFinite(tMs) ||
        !Number.isFinite(ev.price) ||
        ev.price <= 0 ||
        !Number.isFinite(ev.qty) ||
        ev.qty <= 0 ||
        !liveVenueAllowsTradeOverlay(venue, snapshot.venue, tMs)
      ) {
        continue;
      }
      // 버퍼는 시간순 append 라 마지막 유효 체결이 곧 최신 — TTL 초과면 더
      // 과거를 뒤져도 전부 초과이므로 즉시 null.
      return nowMs - tMs <= TRADE_PRICE_FRESH_MS ? ev.price : null;
    }
  }
  return null;
}

/**
 * 현재가 라인·상태바 공용 현재가 resolver — "라인 = 상태바" invariant 의 단일
 * 구현점. 우선순위: fresh 체결가(≤150ms/2s) > 사용가능 quote.price(10s 폴) >
 * 마지막 캔들 종가(기존 동작 = 최종 폴백). 캔들이 없으면(lastClose null) 무조건
 * null — 라인 숨김·상태바 '대기 중' 현행 계약 유지.
 */
export function resolveLiveCurrentPrice(
  lastClose: number | null,
  quote: LiveQuote | undefined,
  liveTradePrice: number | null | undefined,
): number | null {
  if (lastClose == null) return null;
  if (liveTradePrice != null) return liveTradePrice;
  // stale(kis_rest_bypassed 등)·0원·비유한 quote 는 배제 → 캔들 종가 폴백.
  if (quote != null && !isStaleLiveQuote(quote) && Number.isFinite(quote.price) && quote.price > 0) {
    return quote.price;
  }
  return lastClose;
}

/**
 * 현재가 라인의 가격·색을 산출하는 순수 함수.
 *  - price = resolveLiveCurrentPrice (LiveStatusBar 의 현재가와 동일 산출):
 *    fresh 체결가 > 사용가능 quote.price > 마지막 캔들 종가.
 *  - color basis = change_won ?? change_pct (QuoteChange/priceDirClass 컨벤션과 동일):
 *    >0 빨강 / <0 파랑 / 0·null 중립. won 우선이나 won-null+pct-값(OPEN 단계 일부
 *    quote, kis_client.py)에선 pct 부호로 폴백해 Status Bar 색과 항상 일치한다.
 */
export function deriveCurrentPriceLine(
  bundle: RangeBundle,
  quote: LiveQuote | undefined,
  colors: PriceLineColors,
  liveTradePrice?: number | null,
): PriceLineModel {
  const { candles } = bundle;
  if (candles.length === 0) return null;
  const lastClose = candles[candles.length - 1].close;
  const price = resolveLiveCurrentPrice(lastClose, quote, liveTradePrice);
  if (price == null) return null;
  const basis = quote == null ? null : (quote.change_won ?? quote.change_pct ?? null);
  const color =
    basis == null || basis === 0
      ? colors.neutral
      : basis > 0
        ? colors.up
        : colors.down;
  return { price, color };
}
