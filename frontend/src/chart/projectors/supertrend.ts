import type { Candle } from '../../api/types';
import type { LineData, Time, WhitespaceData } from 'lightweight-charts';

type Price = Pick<Candle, 'high' | 'low' | 'close'>;
export type SupertrendPoint = { value: number; direction: 'up' | 'down'; atr: number };

/** HL2 bands with Wilder ATR (SMA seed, then RMA). The first complete ATR
 * starts in a downtrend; subsequent closes must strictly cross the final band.
 * https://www.tradingview.com/support/solutions/43000634738-supertrend/
 * Invalid bars reset the seed so a bad price cannot poison the whole history.
 */
export function computeSupertrend(
  candles: readonly Price[], period: number, multiplier: number,
): (SupertrendPoint | null)[] {
  const out: (SupertrendPoint | null)[] = candles.map(() => null);
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(multiplier) || multiplier <= 0) return out;
  let count = 0, seed = 0;
  let atr: number | null = null, previousClose: number | null = null;
  let upper = 0, lower = 0;
  let direction: SupertrendPoint['direction'] = 'down';
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    if (![high, low, close].every(Number.isFinite) || high < low) {
      count = seed = 0;
      atr = previousClose = null;
      direction = 'down';
      continue;
    }
    const tr = previousClose === null ? high - low
      : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    if (atr === null) {
      seed += tr;
      count++;
      if (count < period) { previousClose = close; continue; }
      atr = seed / period;
      upper = (high + low) / 2 + multiplier * atr;
      lower = (high + low) / 2 - multiplier * atr;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      const basicUpper = (high + low) / 2 + multiplier * atr;
      const basicLower = (high + low) / 2 - multiplier * atr;
      upper = basicUpper < upper || previousClose! > upper ? basicUpper : upper;
      lower = basicLower > lower || previousClose! < lower ? basicLower : lower;
      direction = direction === 'down'
        ? close > upper ? 'up' : 'down'
        : close < lower ? 'down' : 'up';
    }
    out[i] = { value: direction === 'up' ? lower : upper, direction, atr };
    previousClose = close;
  }
  return out;
}

/** LWC colors the outgoing segment with the start point's color. Whitespace
 * alone does not break that connector: retain values but make flip/gap
 * connectors transparent, so no diagonal joins opposite trend bands.
 */
export function supertrendLineData(
  values: readonly (SupertrendPoint | null)[], times: readonly number[], upColor: string, downColor: string,
  visibility: Readonly<{ up: boolean; down: boolean }> = { up: true, down: true },
): (LineData<Time> | WhitespaceData<Time>)[] {
  return values.map((point, i) => {
    const time = times[i] as Time;
    if (!point) return { time };
    const next = values[i + 1];
    const broken = !visibility[point.direction] || (i < values.length - 1 && (!next || next.direction !== point.direction));
    return { time, value: point.value, color: broken ? 'transparent' : point.direction === 'up' ? upColor : downColor };
  });
}
