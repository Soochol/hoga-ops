import { useMemo } from 'react';
import type { AskPeakCandidate, BidPeak, Candle } from '../api/types';
import type { LiveTodayBidPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import {
  classifyBidWallEvents,
  rankPeakCandidates,
  toTouchTicksFromTrades,
  toWallEventsFromOrderbooks,
} from './peakWallEventClassifier';

const EMPTY_CANDLES: readonly Candle[] = [];

type PeakFamilies = {
  traded: AskPeakCandidate[];
  untraded: AskPeakCandidate[];
  all: AskPeakCandidate[];
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function candidateKey(candidate: AskPeakCandidate): string {
  return `${candidate.price}:${candidate.qty}:${candidate.t_ms}`;
}

function uniqueCandidates(candidates: readonly AskPeakCandidate[]): AskPeakCandidate[] {
  const out: AskPeakCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function mergeRankedCandidates(...groups: ReadonlyArray<readonly AskPeakCandidate[]>): AskPeakCandidate[] {
  return rankPeakCandidates(groups.flatMap((group) => group));
}

function rankUniqueCandidates(candidates: readonly AskPeakCandidate[]): AskPeakCandidate[] {
  return rankPeakCandidates(uniqueCandidates(candidates));
}

function toCandidate(
  price: unknown,
  qty: unknown,
  tMs: unknown,
): AskPeakCandidate | null {
  return isFiniteNumber(price) && isFiniteNumber(qty) && isFiniteNumber(tMs)
    ? { price, qty, t_ms: tMs }
    : null;
}

function candidateFromPrefix(
  peak: LiveTodayBidPeak | null,
  prefix: 'traded' | 'all' | 'untraded',
): AskPeakCandidate | null {
  if (!peak) return null;
  return toCandidate(
    peak[`${prefix}_price` as keyof LiveTodayBidPeak],
    peak[`${prefix}_qty` as keyof LiveTodayBidPeak],
    peak[`${prefix}_t_ms` as keyof LiveTodayBidPeak],
  );
}

function backendPeakFamilies(todayBidPeak: LiveTodayBidPeak | null): PeakFamilies {
  const traded = todayBidPeak?.traded_peaks?.length
    ? todayBidPeak.traded_peaks
    : [candidateFromPrefix(todayBidPeak, 'traded')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  const untraded = todayBidPeak?.untraded_peaks?.length
    ? todayBidPeak.untraded_peaks
    : [candidateFromPrefix(todayBidPeak, 'untraded')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  const all = todayBidPeak?.all_peaks?.length
    ? todayBidPeak.all_peaks
    : [candidateFromPrefix(todayBidPeak, 'all')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  return {
    traded: rankPeakCandidates(traded),
    untraded: rankPeakCandidates(untraded),
    all: rankPeakCandidates(all),
  };
}

function bidPeakFromCandidate(date: string, candidate: AskPeakCandidate): BidPeak {
  return {
    date,
    price: candidate.price,
    qty: candidate.qty,
    t_ms: candidate.t_ms,
    max_price: candidate.price,
    max_qty: candidate.qty,
    max_t_ms: candidate.t_ms,
  };
}

function attachFamilies(
  peak: BidPeak,
  families: PeakFamilies,
): BidPeak {
  const untraded = families.untraded[0] ?? null;
  return {
    ...peak,
    traded_peaks: families.traded,
    traded_max_peaks: families.traded,
    all_peaks: families.all,
    all_max_peaks: families.all,
    untraded_price: untraded?.price ?? null,
    untraded_qty: untraded?.qty ?? null,
    untraded_t_ms: untraded?.t_ms ?? null,
    untraded_max_price: untraded?.price ?? null,
    untraded_max_qty: untraded?.qty ?? null,
    untraded_max_t_ms: untraded?.t_ms ?? null,
    untraded_peaks: families.untraded,
    untraded_max_peaks: families.untraded,
  };
}

function mergedBidFamilies(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  todayBidPeak: LiveTodayBidPeak | null,
): PeakFamilies {
  const backend = backendPeakFamilies(todayBidPeak);
  const touchTicks = toTouchTicksFromTrades(trade);
  const sourceEvents = uniqueCandidates([
    ...toWallEventsFromOrderbooks(ob, 'bid'),
    ...backend.all,
    ...backend.traded,
    ...backend.untraded,
  ]);
  const classified = classifyBidWallEvents(sourceEvents, touchTicks);
  const traded = mergeRankedCandidates(classified.postTouch, backend.traded);
  const tradedKeys = new Set(traded.map(candidateKey));
  const untraded = rankUniqueCandidates(
    [...classified.postUntouched, ...backend.untraded]
      .filter((candidate) => !tradedKeys.has(candidateKey(candidate))),
  );
  const all = mergeRankedCandidates(classified.all, backend.all, traded, untraded);
  return { traded, untraded, all };
}

function historicalTodaySeed(seeds: readonly BidPeak[], todayKst: string): AskPeakCandidate | null {
  const today = seeds.find((peak) => peak.date === todayKst);
  if (!today) return null;
  return toCandidate(today.price, today.qty, today.t_ms);
}

export function buildTodayTradedBidPeak(todayBidPeak: LiveTodayBidPeak | null): BidPeak | null {
  const families = backendPeakFamilies(todayBidPeak);
  const date = todayBidPeak?.date;
  const traded = families.traded[0];
  if (!date || !traded) return null;
  return attachFamilies(bidPeakFromCandidate(date, traded), families);
}

export function buildTodayAllPriceBidPeak(todayBidPeak: LiveTodayBidPeak | null): BidPeak | null {
  const families = backendPeakFamilies(todayBidPeak);
  const date = todayBidPeak?.date;
  const all = families.all[0];
  if (!date || !all) return null;
  return attachFamilies(bidPeakFromCandidate(date, all), families);
}

export function useDayBidPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): BidPeak[] {
  void code;
  void todayCandles;
  const families = useMemo(
    () => mergedBidFamilies(ob, trade, todayBidPeak),
    [ob, trade, todayBidPeak],
  );

  return useMemo(() => {
    const out = seeds.filter((peak) => peak.date !== todayKst);
    const traded = families.traded[0];
    if (!traded) return out;
    out.push(attachFamilies(bidPeakFromCandidate(todayKst, traded), families));
    return out;
  }, [families, seeds, todayKst]);
}

export function useTodayAllPriceBidPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
): BidPeak | null {
  void code;
  const backend = useMemo(() => backendPeakFamilies(todayBidPeak), [todayBidPeak]);
  const todaySeed = useMemo(() => historicalTodaySeed(seeds, todayKst), [seeds, todayKst]);
  const allCandidates = useMemo(
    () => mergeRankedCandidates(
      toWallEventsFromOrderbooks(ob, 'bid'),
      backend.all,
      todayBidPeak === null && todaySeed ? [todaySeed] : [],
    ),
    [ob, backend.all, todayBidPeak, todaySeed],
  );

  return useMemo(() => {
    const all = allCandidates[0];
    if (!all) return null;
    return attachFamilies(
      bidPeakFromCandidate(todayKst, all),
      {
        traded: backend.traded,
        untraded: backend.untraded,
        all: allCandidates,
      },
    );
  }, [allCandidates, backend.traded, backend.untraded, todayKst]);
}
