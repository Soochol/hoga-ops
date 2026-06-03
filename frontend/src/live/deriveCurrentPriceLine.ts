import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';

export type PriceLineColors = { up: string; down: string; neutral: string };
export type PriceLineModel = { price: number; color: string } | null;

/**
 * 현재가 라인의 가격·색을 산출하는 순수 함수.
 *  - price = 마지막 캔들 종가 (LiveStatusBar 의 현재가와 동일 산출).
 *  - color basis = change_won ?? change_pct (QuoteChange/priceDirClass 컨벤션과 동일):
 *    >0 빨강 / <0 파랑 / 0·null 중립. won 우선이나 won-null+pct-값(OPEN 단계 일부
 *    quote, kis_client.py)에선 pct 부호로 폴백해 Status Bar 색과 항상 일치한다.
 */
export function deriveCurrentPriceLine(
  bundle: RangeBundle,
  quote: LiveQuote | undefined,
  colors: PriceLineColors,
): PriceLineModel {
  const { candles } = bundle;
  if (candles.length === 0) return null;
  const price = candles[candles.length - 1].close;
  const basis = quote == null ? null : (quote.change_won ?? quote.change_pct ?? null);
  const color =
    basis == null || basis === 0
      ? colors.neutral
      : basis > 0
        ? colors.up
        : colors.down;
  return { price, color };
}
