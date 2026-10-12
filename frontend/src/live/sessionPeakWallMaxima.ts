import type { AskPeakCandidate } from '../api/types';
import type { PeakWallInput } from './peakWallSegments';

/** The display buffer slides; a touched wall and an all-wall maximum do not expire.
 * Keep only three distinct prices per family, outside the window-scoped classifier.
 * Unreached walls retain their current classification: reaching them can lower that family.
 */
export class SessionPeakWallMaxima {
  private scope = '';
  private traded: AskPeakCandidate[] = [];
  private all: AskPeakCandidate[] = [];

  update(rows: PeakWallInput[], today: string, scope: string): PeakWallInput[] {
    if (scope !== this.scope) {
      this.scope = scope;
      this.traded = [];
      this.all = [];
    }
    const index = rows.findIndex((row) => row.date === today);
    const row = index >= 0 ? rows[index] : undefined;
    this.traded = mergeMaxima(this.traded, row?.traded_peaks ?? []);
    this.all = mergeMaxima(this.all, row?.all_peaks ?? []);
    if (this.all.length === 0) return rows;
    const best = this.traded[0];
    const preserved = {
      ...row,
      date: today,
      price: best?.price ?? null,
      qty: best?.qty ?? null,
      t_ms: best?.t_ms ?? null,
      max_price: best?.price ?? null,
      max_qty: best?.qty ?? null,
      max_t_ms: best?.t_ms ?? null,
      traded_peaks: this.traded,
      traded_max_peaks: this.traded,
      all_peaks: this.all,
      all_max_peaks: this.all,
    };
    const out = rows.slice();
    if (index >= 0) out[index] = preserved;
    else out.push(preserved);
    return out;
  }
}

function mergeMaxima(previous: AskPeakCandidate[], incoming: readonly AskPeakCandidate[]): AskPeakCandidate[] {
  const ranked = [...previous, ...incoming].sort(
    (a, b) => b.qty - a.qty || a.t_ms - b.t_ms || a.price - b.price,
  );
  const seen = new Set<number>();
  return ranked.filter((candidate) => {
    if (seen.has(candidate.price)) return false;
    seen.add(candidate.price);
    return true;
  }).slice(0, 3);
}
