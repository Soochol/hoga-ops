export type BollingerPoint = { middle: number; upper: number; lower: number };

/** SMA ± multiplier × population standard deviation of the same trailing window.
 * Centering prices avoids cancellation in E[x²] − E[x]² for high-price stocks.
 * Rebase once per window to bound accumulated rounding error; total work is O(n).
 */
export function computeBollingerBands(
  prices: readonly number[], period: number, multiplier: number,
): (BollingerPoint | null)[] {
  const out: (BollingerPoint | null)[] = prices.map(() => null);
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(multiplier) || multiplier < 0) return out;
  let origin = 0, sum = 0, squares = 0, invalid = 0;
  for (let i = 0; i < prices.length; i++) {
    const start = Math.max(0, i - period + 1);
    if (i % period === 0) {
      origin = Number.isFinite(prices[i]) ? prices[i] : 0;
      sum = squares = invalid = 0;
      for (let j = start; j <= i; j++) {
        if (!Number.isFinite(prices[j])) { invalid++; continue; }
        const delta = prices[j] - origin;
        sum += delta;
        squares += delta * delta;
      }
    } else {
      if (i >= period) {
        const old = prices[i - period];
        if (!Number.isFinite(old)) invalid--;
        else { const delta = old - origin; sum -= delta; squares -= delta * delta; }
      }
      if (!Number.isFinite(prices[i])) invalid++;
      else { const delta = prices[i] - origin; sum += delta; squares += delta * delta; }
    }
    if (i < period - 1 || invalid > 0) continue;
    const mean = sum / period;
    const middle = origin + mean;
    const width = multiplier * Math.sqrt(Math.max(0, squares / period - mean * mean));
    out[i] = { middle, upper: middle + width, lower: middle - width };
  }
  return out;
}
