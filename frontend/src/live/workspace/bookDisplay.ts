/** Historical ladders use their own baseline; single-price books use today's
 * close. Missing single-price baselines must not fall back to yesterday's close. */
export function resolveBookBaseline({ isPastDateLadder, ladderBaseline, singlePriceActive, singlePriceClose, liveBaseline }: {
  isPastDateLadder: boolean; ladderBaseline: number | null;
  singlePriceActive: boolean; singlePriceClose: number | null; liveBaseline: number | null;
}): number | null {
  if (isPastDateLadder) return ladderBaseline;
  if (singlePriceActive) return singlePriceClose;
  return liveBaseline;
}
