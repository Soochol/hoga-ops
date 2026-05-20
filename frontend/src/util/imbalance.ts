/**
 * Quote imbalance: signed log-ratio-like measure of bid vs ask depth.
 *
 *   bid > ask  → negative (buy heavy)
 *   ask > bid  → positive (sell heavy)
 *   bid = ask  → 0
 *   either ≤ 0 → 0 (degenerate)
 */
export function quoteImbalance(bid: number, ask: number): number {
  if (bid <= 0 || ask <= 0) return 0;
  return ask >= bid ? ask / bid - 1 : -(bid / ask - 1);
}
