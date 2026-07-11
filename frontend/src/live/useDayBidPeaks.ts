import { useMemo, useRef } from 'react';
import type { AskPeakCandidate, BidPeak, Candle } from '../api/types';
import type { LiveTodayBidPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';
import {
  classifyBidWallEvents,
  rankPeakCandidates,
  toTouchTicksFromTrades,
  toWallEventsFromOrderbooks,
  type PeakWallClassification,
} from './peakWallEventClassifier';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';

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

/** classify 결과 + 백엔드 패밀리 → 최종 패밀리 조립. 배치(mergedBidFamilies)와
 *  증분(useDayBidPeaks) 경로가 공유하는 유일한 조립 구현. */
function bidFamiliesFromClassified(
  classified: PeakWallClassification,
  backend: PeakFamilies,
): PeakFamilies {
  const traded = mergeRankedCandidates(classified.postTouch, backend.traded);
  const tradedKeys = new Set(traded.map(candidateKey));
  const untraded = rankUniqueCandidates(
    [...classified.postUntouched, ...backend.untraded]
      .filter((candidate) => !tradedKeys.has(candidateKey(candidate))),
  );
  const all = mergeRankedCandidates(classified.all, backend.all, traded, untraded);
  return { traded, untraded, all };
}

function mergedBidFamilies(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  todayBidPeak: LiveTodayBidPeak | null,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): PeakFamilies {
  const backend = backendPeakFamilies(todayBidPeak);
  const filteredOb = visibleTimeCutoff
    ? ob.filter((snapshot) => snapshot.t_ms <= visibleTimeCutoff.tMs)
    : ob;
  const filteredTrade = visibleTimeCutoff
    ? trade
      .map((snapshot) => {
        const trades = snapshot.trades.filter((item) => {
          const tMs = isFiniteNumber(item.t_ms) ? item.t_ms : snapshot.t_ms;
          return isFiniteNumber(tMs) && tMs <= visibleTimeCutoff.tMs;
        });
        return trades.length > 0 ? { ...snapshot, trades } : null;
      })
      .filter((snapshot): snapshot is TradeSnapshot => snapshot !== null)
    : trade;
  const filterCandidates = (candidates: readonly AskPeakCandidate[]) =>
    visibleTimeCutoff
      ? candidates.filter((candidate) => candidate.t_ms <= visibleTimeCutoff.tMs)
      : candidates;
  const touchTicks = toTouchTicksFromTrades(filteredTrade);
  const sourceEvents = uniqueCandidates([
    ...toWallEventsFromOrderbooks(filteredOb, 'bid'),
    ...filterCandidates(backend.all),
    ...filterCandidates(backend.traded),
    ...filterCandidates(backend.untraded),
  ]);
  const classified = classifyBidWallEvents(sourceEvents, touchTicks);
  if (visibleTimeCutoff) {
    const traded = rankPeakCandidates(classified.postTouch);
    const tradedKeys = new Set(traded.map(candidateKey));
    const untraded = rankUniqueCandidates(
      classified.postUntouched.filter((candidate) => !tradedKeys.has(candidateKey(candidate))),
    );
    return {
      traded,
      untraded,
      all: rankPeakCandidates(classified.all),
    };
  }
  return bidFamiliesFromClassified(classified, backend);
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

export function deriveDayBidPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): BidPeak[] {
  void code;
  void todayCandles;
  const families = mergedBidFamilies(ob, trade, todayBidPeak, visibleTimeCutoff);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  const traded = families.traded[0];
  if (!traded) return out;
  out.push(attachFamilies(bidPeakFromCandidate(todayKst, traded), families));
  return out;
}

export function deriveDayBidPeaksIncremental(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  todayBidPeak: LiveTodayBidPeak | null,
): BidPeak[] {
  const backend = backendPeakFamilies(todayBidPeak);
  const classified = source.update(ob, trade, [
    ...backend.all,
    ...backend.traded,
    ...backend.untraded,
  ]);
  const families = bidFamiliesFromClassified(classified, backend);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  const traded = families.traded[0];
  if (!traded) return out;
  out.push(attachFamilies(bidPeakFromCandidate(todayKst, traded), families));
  return out;
}

function filterCandidatesByCutoff(
  candidates: readonly AskPeakCandidate[],
  cutoffMs: number,
): AskPeakCandidate[] {
  return candidates.filter((candidate) => candidate.t_ms <= cutoffMs);
}

/** mergedBidFamilies 의 cutoff 분기와 동일(증분 경로 전용). */
function bidFamiliesFromClassifiedCutoff(classified: PeakWallClassification): PeakFamilies {
  const traded = rankPeakCandidates(classified.postTouch);
  const tradedKeys = new Set(traded.map(candidateKey));
  const untraded = rankUniqueCandidates(
    classified.postUntouched.filter((candidate) => !tradedKeys.has(candidateKey(candidate))),
  );
  const all = rankPeakCandidates(classified.all);
  return { traded, untraded, all };
}

/** deriveDayBidPeaks(cutoff) 의 증분판. */
export function deriveDayBidPeaksIncrementalAsOf(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  todayBidPeak: LiveTodayBidPeak | null,
  cutoffMs: number,
): BidPeak[] {
  const backend = backendPeakFamilies(todayBidPeak);
  const classified = source.updateAsOf(ob, trade, [
    ...backend.all,
    ...backend.traded,
    ...backend.untraded,
  ], cutoffMs);
  const families = bidFamiliesFromClassifiedCutoff(classified);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  const traded = families.traded[0];
  if (!traded) return out;
  out.push(attachFamilies(bidPeakFromCandidate(todayKst, traded), families));
  return out;
}

/** deriveTodayAllPriceBidPeak(cutoff) 의 증분판. */
export function deriveTodayAllPriceBidPeakIncrementalAsOf(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  todayBidPeak: LiveTodayBidPeak | null,
  cutoffMs: number,
): BidPeak | null {
  const backend = backendPeakFamilies(todayBidPeak);
  const todaySeed = historicalTodaySeed(seeds, todayKst);
  const classified = source.updateAsOf(ob, EMPTY_TRADES, [
    ...backend.all,
    ...(todayBidPeak === null && todaySeed ? [todaySeed] : []),
  ], cutoffMs);
  const all = classified.all[0];
  if (!all) return null;
  return attachFamilies(
    bidPeakFromCandidate(todayKst, all),
    {
      traded: filterCandidatesByCutoff(backend.traded, cutoffMs),
      untraded: filterCandidatesByCutoff(backend.untraded, cutoffMs),
      all: classified.all,
    },
  );
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
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('bid');
  return useMemo(
    () => deriveDayBidPeaksIncremental(sourceRef.current!, ob, trade, seeds, todayKst, todayBidPeak),
    [ob, trade, seeds, todayKst, todayBidPeak],
  );
}

export function deriveTodayAllPriceBidPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): BidPeak | null {
  void code;
  const backend = backendPeakFamilies(todayBidPeak);
  const todaySeed = historicalTodaySeed(seeds, todayKst);
  const filterCandidates = (candidates: readonly AskPeakCandidate[]) =>
    visibleTimeCutoff
      ? candidates.filter((candidate) => candidate.t_ms <= visibleTimeCutoff.tMs)
      : candidates;
  const filteredOb = visibleTimeCutoff
    ? ob.filter((snapshot) => snapshot.t_ms <= visibleTimeCutoff.tMs)
    : ob;
  const allCandidates = mergeRankedCandidates(
    toWallEventsFromOrderbooks(filteredOb, 'bid'),
    filterCandidates(backend.all),
    todayBidPeak === null && todaySeed ? [todaySeed] : [],
  );
  const all = allCandidates[0];
  if (!all) return null;
  return attachFamilies(
    bidPeakFromCandidate(todayKst, all),
    {
      traded: [...filterCandidates(backend.traded)],
      untraded: [...filterCandidates(backend.untraded)],
      all: allCandidates,
    },
  );
}

const EMPTY_TRADES: readonly TradeSnapshot[] = [];

export function deriveTodayAllPriceBidPeakIncremental(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  todayBidPeak: LiveTodayBidPeak | null,
): BidPeak | null {
  const backend = backendPeakFamilies(todayBidPeak);
  const todaySeed = historicalTodaySeed(seeds, todayKst);
  const classified = source.update(ob, EMPTY_TRADES, [
    ...backend.all,
    ...(todayBidPeak === null && todaySeed ? [todaySeed] : []),
  ]);
  const all = classified.all[0];
  if (!all) return null;
  return attachFamilies(
    bidPeakFromCandidate(todayKst, all),
    {
      traded: [...backend.traded],
      untraded: [...backend.untraded],
      all: classified.all,
    },
  );
}

export function useTodayAllPriceBidPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
): BidPeak | null {
  void code;
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('bid');
  return useMemo(
    () => deriveTodayAllPriceBidPeakIncremental(sourceRef.current!, ob, seeds, todayKst, todayBidPeak),
    [ob, seeds, todayKst, todayBidPeak],
  );
}
