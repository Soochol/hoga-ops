import type { IRange, Time } from 'lightweight-charts';
import type { AskPeak, AskPeakCandidate, BidPeak, Candle, PeakBase } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { realMsToYyyymmdd } from './liveDateTime';

export type VisibleTimeCutoff = {
  date: string;
  tMs: number;
};

type PeakSide = 'ask' | 'bid';

type CutoffOptions = {
  side: PeakSide;
  intraMax: boolean;
};

type PeakWithCandidates = (AskPeak | BidPeak) & {
  traded_peaks?: AskPeakCandidate[];
  traded_max_peaks?: AskPeakCandidate[];
};

function finiteTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function filterCandidatesByCutoff(
  candidates: readonly AskPeakCandidate[] | undefined,
  cutoff: VisibleTimeCutoff,
): AskPeakCandidate[] | undefined {
  if (!candidates?.length) return candidates;
  return candidates.filter((candidate) => candidate.t_ms <= cutoff.tMs);
}

export function rightmostVisibleCandleCutoff(
  candles: readonly Candle[],
  visibleRange: IRange<Time> | null,
  axis: VirtualAxis,
): VisibleTimeCutoff | null {
  if (!visibleRange || candles.length === 0) return null;
  const visibleTo = Number(visibleRange.to) * 1000;
  if (!Number.isFinite(visibleTo)) return null;
  const realTo = axis.toReal(visibleTo);
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts_ms <= realTo) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const selected = candles[ans >= 0 ? ans : 0];
  if (!selected) return null;
  return { date: realMsToYyyymmdd(selected.ts_ms), tMs: selected.ts_ms };
}

function candidateFromPeak(peak: PeakBase, intraMax: boolean): AskPeakCandidate {
  return intraMax
    ? { price: peak.max_price, qty: peak.max_qty, t_ms: peak.max_t_ms }
    : { price: peak.price, qty: peak.qty, t_ms: peak.t_ms };
}

function maxCandidateFromPeak(peak: PeakBase, intraMax: boolean): AskPeakCandidate {
  return intraMax
    ? { price: peak.max_price, qty: peak.max_qty, t_ms: peak.max_t_ms }
    : { price: peak.price, qty: peak.qty, t_ms: peak.t_ms };
}

function chooseCandidate(
  peak: PeakWithCandidates,
  cutoff: VisibleTimeCutoff,
  intraMax: boolean,
): { close: AskPeakCandidate; max: AskPeakCandidate } | null {
  const closeCandidates = peak.traded_peaks?.length
    ? peak.traded_peaks
    : [candidateFromPeak(peak, false)];
  const maxCandidates = peak.traded_max_peaks?.length
    ? peak.traded_max_peaks
    : [maxCandidateFromPeak(peak, true)];
  const sourceCandidates = intraMax ? maxCandidates : closeCandidates;
  const selected = sourceCandidates
    .filter((candidate) => candidate.t_ms <= cutoff.tMs)
    .sort((a, b) => b.qty - a.qty || a.t_ms - b.t_ms || a.price - b.price)[0];
  if (!selected) return null;
  const selectedIndex = sourceCandidates.findIndex((candidate) =>
    candidate.price === selected.price
    && candidate.qty === selected.qty
    && candidate.t_ms === selected.t_ms,
  );
  const fallbackIndex = selectedIndex >= 0 ? selectedIndex : 0;
  return {
    close: closeCandidates[fallbackIndex] ?? selected,
    max: maxCandidates[fallbackIndex] ?? selected,
  };
}

function cutoffNullableTriple<T extends PeakWithCandidates>(
  peak: T,
  cutoff: VisibleTimeCutoff,
  prefix: 'untraded' | 'all',
): Partial<T> {
  const price = peak[`${prefix}_price` as keyof T] as number | null | undefined;
  const qty = peak[`${prefix}_qty` as keyof T] as number | null | undefined;
  const tMs = finiteTime(peak[`${prefix}_t_ms` as keyof T]);
  const maxPrice = peak[`${prefix}_max_price` as keyof T] as number | null | undefined;
  const maxQty = peak[`${prefix}_max_qty` as keyof T] as number | null | undefined;
  const maxTMs = finiteTime(peak[`${prefix}_max_t_ms` as keyof T]);
  const closeOk = tMs !== null && tMs <= cutoff.tMs;
  const maxOk = maxTMs !== null && maxTMs <= cutoff.tMs;
  return {
    [`${prefix}_price`]: closeOk ? price : null,
    [`${prefix}_qty`]: closeOk ? qty : null,
    [`${prefix}_t_ms`]: closeOk ? tMs : null,
    [`${prefix}_max_price`]: maxOk ? maxPrice : null,
    [`${prefix}_max_qty`]: maxOk ? maxQty : null,
    [`${prefix}_max_t_ms`]: maxOk ? maxTMs : null,
  } as Partial<T>;
}

export function applyPeakVisibleTimeCutoff<T extends PeakWithCandidates>(
  peaks: readonly T[],
  cutoff: VisibleTimeCutoff | null,
  options: CutoffOptions,
): T[] {
  void options.side;
  if (!cutoff) return [...peaks];
  const out: T[] = [];
  for (const peak of peaks) {
    if (peak.date < cutoff.date) {
      out.push(peak);
      continue;
    }
    if (peak.date > cutoff.date) continue;
    const selected = chooseCandidate(peak, cutoff, options.intraMax);
    if (!selected) continue;
    out.push({
      ...peak,
      price: selected.close.price,
      qty: selected.close.qty,
      t_ms: selected.close.t_ms,
      max_price: selected.max.price,
      max_qty: selected.max.qty,
      max_t_ms: selected.max.t_ms,
      traded_peaks: filterCandidatesByCutoff(peak.traded_peaks, cutoff),
      traded_max_peaks: filterCandidatesByCutoff(peak.traded_max_peaks, cutoff),
      ...cutoffNullableTriple(peak, cutoff, 'untraded'),
      ...cutoffNullableTriple(peak, cutoff, 'all'),
    });
  }
  return out;
}
