import { useMemo, useRef } from 'react';
import type { AskPeak, AskPeakCandidate, Candle } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';
import {
  classifyAskWallEvents,
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
  peak: LiveTodayAskPeak | null,
  prefix: 'traded' | 'all' | 'untraded',
): AskPeakCandidate | null {
  if (!peak) return null;
  return toCandidate(
    peak[`${prefix}_price` as keyof LiveTodayAskPeak],
    peak[`${prefix}_qty` as keyof LiveTodayAskPeak],
    peak[`${prefix}_t_ms` as keyof LiveTodayAskPeak],
  );
}

function backendPeakFamilies(todayAskPeak: LiveTodayAskPeak | null): PeakFamilies {
  const traded = todayAskPeak?.traded_peaks?.length
    ? todayAskPeak.traded_peaks
    : [candidateFromPrefix(todayAskPeak, 'traded')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  const untraded = todayAskPeak?.untraded_peaks?.length
    ? todayAskPeak.untraded_peaks
    : [candidateFromPrefix(todayAskPeak, 'untraded')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  const all = todayAskPeak?.all_peaks?.length
    ? todayAskPeak.all_peaks
    : [candidateFromPrefix(todayAskPeak, 'all')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  return {
    traded: rankPeakCandidates(traded),
    untraded: rankPeakCandidates(untraded),
    all: rankPeakCandidates(all),
  };
}

function askPeakFromCandidate(date: string, candidate: AskPeakCandidate): AskPeak {
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
  peak: AskPeak,
  families: PeakFamilies,
): AskPeak {
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

/** classify 결과 + 백엔드 패밀리 → 최종 패밀리 조립. 배치(mergedAskFamilies)와
 *  증분(useDayAskPeaks) 경로가 공유하는 유일한 조립 구현 — 여기가 갈라지면 동등성이
 *  깨지므로 반드시 한 곳만 둔다. */
function askFamiliesFromClassified(
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

function mergedAskFamilies(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  todayAskPeak: LiveTodayAskPeak | null,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): PeakFamilies {
  const backend = backendPeakFamilies(todayAskPeak);
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
    ...toWallEventsFromOrderbooks(filteredOb, 'ask'),
    ...filterCandidates(backend.all),
    ...filterCandidates(backend.traded),
    ...filterCandidates(backend.untraded),
  ]);
  const classified = classifyAskWallEvents(sourceEvents, touchTicks);
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
  return askFamiliesFromClassified(classified, backend);
}

function historicalTodaySeed(seeds: readonly AskPeak[], todayKst: string): AskPeakCandidate | null {
  const today = seeds.find((peak) => peak.date === todayKst);
  if (!today) return null;
  return toCandidate(today.price, today.qty, today.t_ms);
}

export function buildTodayTradedAskPeak(todayAskPeak: LiveTodayAskPeak | null): AskPeak | null {
  const families = backendPeakFamilies(todayAskPeak);
  const date = todayAskPeak?.date;
  const traded = families.traded[0];
  if (!date || !traded) return null;
  return attachFamilies(askPeakFromCandidate(date, traded), families);
}

export function buildTodayAllPriceAskPeak(todayAskPeak: LiveTodayAskPeak | null): AskPeak | null {
  const families = backendPeakFamilies(todayAskPeak);
  const date = todayAskPeak?.date;
  const all = families.all[0];
  if (!date || !all) return null;
  return attachFamilies(askPeakFromCandidate(date, all), families);
}

export function deriveDayAskPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): AskPeak[] {
  void code;
  void todayCandles;
  const families = mergedAskFamilies(ob, trade, todayAskPeak, visibleTimeCutoff);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  const traded = families.traded[0];
  if (!traded) return out;
  out.push(attachFamilies(askPeakFromCandidate(todayKst, traded), families));
  return out;
}

/** deriveDayAskPeaks의 증분판(no-cutoff 전용). source가 ob/trade 스캔을 누적으로
 *  대체하고, 조립은 배치와 동일한 askFamiliesFromClassified를 쓴다. */
export function deriveDayAskPeaksIncremental(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  todayAskPeak: LiveTodayAskPeak | null,
): AskPeak[] {
  const backend = backendPeakFamilies(todayAskPeak);
  const classified = source.update(ob, trade, [
    ...backend.all,
    ...backend.traded,
    ...backend.untraded,
  ]);
  const families = askFamiliesFromClassified(classified, backend);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  const traded = families.traded[0];
  if (!traded) return out;
  out.push(attachFamilies(askPeakFromCandidate(todayKst, traded), families));
  return out;
}

export function useDayAskPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): AskPeak[] {
  void code;
  void todayCandles;
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('ask');
  return useMemo(
    () => deriveDayAskPeaksIncremental(sourceRef.current!, ob, trade, seeds, todayKst, todayAskPeak),
    [ob, trade, seeds, todayKst, todayAskPeak],
  );
}

export function deriveTodayAllPriceAskPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): AskPeak | null {
  void code;
  const backend = backendPeakFamilies(todayAskPeak);
  const todaySeed = historicalTodaySeed(seeds, todayKst);
  const filterCandidates = (candidates: readonly AskPeakCandidate[]) =>
    visibleTimeCutoff
      ? candidates.filter((candidate) => candidate.t_ms <= visibleTimeCutoff.tMs)
      : candidates;
  const filteredOb = visibleTimeCutoff
    ? ob.filter((snapshot) => snapshot.t_ms <= visibleTimeCutoff.tMs)
    : ob;
  const allCandidates = mergeRankedCandidates(
    toWallEventsFromOrderbooks(filteredOb, 'ask'),
    filterCandidates(backend.all),
    todayAskPeak === null && todaySeed ? [todaySeed] : [],
  );
  const all = allCandidates[0];
  if (!all) return null;
  return attachFamilies(
    askPeakFromCandidate(todayKst, all),
    {
      traded: [...filterCandidates(backend.traded)],
      untraded: [...filterCandidates(backend.untraded)],
      all: allCandidates,
    },
  );
}

const EMPTY_TRADES: readonly TradeSnapshot[] = [];

/** deriveTodayAllPriceAskPeak의 증분판(no-cutoff 전용). 터치(trade) 없이 all
 *  패밀리만 필요하므로 빈 trade 스트림으로 update한다. top-3 합집합의 top-3 =
 *  전체 합집합의 top-3이므로 배치의 mergeRankedCandidates와 결과가 같다. */
export function deriveTodayAllPriceAskPeakIncremental(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  todayAskPeak: LiveTodayAskPeak | null,
): AskPeak | null {
  const backend = backendPeakFamilies(todayAskPeak);
  const todaySeed = historicalTodaySeed(seeds, todayKst);
  const classified = source.update(ob, EMPTY_TRADES, [
    ...backend.all,
    ...(todayAskPeak === null && todaySeed ? [todaySeed] : []),
  ]);
  const all = classified.all[0];
  if (!all) return null;
  return attachFamilies(
    askPeakFromCandidate(todayKst, all),
    {
      traded: [...backend.traded],
      untraded: [...backend.untraded],
      all: classified.all,
    },
  );
}

export function useTodayAllPriceAskPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
): AskPeak | null {
  void code;
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('ask');
  return useMemo(
    () => deriveTodayAllPriceAskPeakIncremental(sourceRef.current!, ob, seeds, todayKst, todayAskPeak),
    [ob, seeds, todayKst, todayAskPeak],
  );
}
