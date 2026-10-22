export type EnvelopePoint = { middle: number; upper: number; lower: number };

/** Trailing SMA with symmetric percentage bands. No partial warm-up values.
 * Invalid prices suppress only the windows containing them. Periodic rebasing
 * bounds floating point drift while keeping total work O(n).
 */
export function computeEnvelope(
  prices: readonly number[], period: number, percent: number,
): (EnvelopePoint | null)[] {
  const out: (EnvelopePoint | null)[] = prices.map(() => null);
  if (!Number.isInteger(period) || period < 1 || !Number.isFinite(percent) || percent < 0) return out;
  let sum = 0, invalid = 0;
  for (let i = 0; i < prices.length; i++) {
    if (i % period === 0) {
      sum = invalid = 0;
      for (let j = Math.max(0, i - period + 1); j <= i; j++) {
        if (Number.isFinite(prices[j])) sum += prices[j];
        else invalid++;
      }
    } else {
      if (i >= period) {
        if (Number.isFinite(prices[i - period])) sum -= prices[i - period];
        else invalid--;
      }
      if (Number.isFinite(prices[i])) sum += prices[i];
      else invalid++;
    }
    if (i < period - 1 || invalid) continue;
    const middle = sum / period;
    out[i] = { middle, upper: middle * (1 + percent / 100), lower: middle * (1 - percent / 100) };
  }
  return out;
}
