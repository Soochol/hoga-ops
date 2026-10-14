import type { TradeSnapshot } from '../bucketHogaSeries';
import type { BookTrade } from './BookPanel';

/** Both book windows unpack the same venue-filtered market prints, newest first. */
export function recentBookTrades(frames: ReadonlyArray<TradeSnapshot>, limit: number): BookTrade[] {
  const out: BookTrade[] = [];
  for (let i = frames.length - 1; i >= 0 && out.length < limit; i--) {
    const rows = frames[i].trades;
    if (!Array.isArray(rows)) continue;
    for (let j = rows.length - 1; j >= 0 && out.length < limit; j--) {
      const row = rows[j] as { price?: unknown; qty?: unknown; side?: unknown };
      if (typeof row?.price === 'number' && typeof row.qty === 'number') {
        out.push({ price: row.price, qty: row.qty, side: typeof row.side === 'number' ? row.side : 0 });
      }
    }
  }
  return out;
}

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
