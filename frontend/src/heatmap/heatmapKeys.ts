/** Single source of the heatmap query key — independent from WATCHLIST_KEY
 *  (ADR-0068). Heatmap mutations invalidate this key ONLY, never ['watchlist'],
 *  so the two lists stay fully decoupled. */
export const HEATMAP_KEY = ['heatmap'] as const;
