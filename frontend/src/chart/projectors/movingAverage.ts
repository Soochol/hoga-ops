import type { Candle } from '../../api/types';

/** 이동평균을 계산할 때 캔들의 어느 가격을 입력 시계열로 쓸지. mockup의
 *  "소스" dropdown과 1:1 대응. close가 가장 흔하지만 분석가에 따라 시고저
 *  또는 가중 평균(HL2/HLC3/OHLC4)을 선호한다. */
export type MASource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export function selectSource(c: Candle, source: MASource): number {
  switch (source) {
    case 'close': return c.close;
    case 'open':  return c.open;
    case 'high':  return c.high;
    case 'low':   return c.low;
    case 'hl2':   return (c.high + c.low) / 2;
    case 'hlc3':  return (c.high + c.low + c.close) / 3;
    case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
  }
}

/**
 * Simple Moving Average over `closes` with window `period`. O(n) sliding-
 * window sum: the first `period - 1` entries are `null` (not enough history
 * to average), then each subsequent entry is the mean of the trailing
 * `period` closes.
 *
 * Edge cases (mirroring the spec):
 *   - `period <= 0`: all-null (no meaningful average).
 *   - `period === 1`: return `closes` verbatim (the MA equals the close).
 *   - `period > closes.length`: all-null (window never fills).
 *   - empty input: empty output.
 */
export function computeSMA(closes: number[], period: number): (number | null)[] {
  if (closes.length === 0) return [];
  if (period <= 0) return closes.map(() => null);
  if (period === 1) return closes.slice();
  if (period > closes.length) return closes.map(() => null);

  const out: (number | null)[] = new Array(closes.length);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    out[i] = i >= period - 1 ? sum / period : null;
  }
  return out;
}
