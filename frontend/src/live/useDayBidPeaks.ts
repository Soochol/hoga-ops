import { useMemo, useRef } from 'react';
import type { AskPeakCandidate, BidPeak, Candle } from '../api/types';
import type { LiveTodayBidPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';
import {
  classifyBidWallEvents,
  dayExtremeFromCandles,
  rankPeakCandidates,
  toTouchTicksFromTrades,
  toWallEventsFromOrderbooks,
  type PeakWallClassification,
} from './peakWallEventClassifier';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';

const EMPTY_CANDLES: readonly Candle[] = [];

type PeakFamilies = {
  /** 동일분 터치 벽(ADR-0156) — UI 의 「체결된 벽」. */
  traded: AskPeakCandidate[];
  /** 터치 무관 전체 벽 — 「보이는 영역 최대벽」의 원천. */
  all: AskPeakCandidate[];
  /** 미도달 벽(당일 저가 기준) — ask 쪽 PeakFamilies 주석 참조(백엔드 별도 병합 없음). */
  unreached: AskPeakCandidate[];
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
  prefix: 'traded' | 'all' | 'unreached',
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
  const all = todayBidPeak?.all_peaks?.length
    ? todayBidPeak.all_peaks
    : [candidateFromPrefix(todayBidPeak, 'all')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  const unreached = todayBidPeak?.unreached_peaks?.length
    ? todayBidPeak.unreached_peaks
    : [candidateFromPrefix(todayBidPeak, 'unreached')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  return {
    traded: rankPeakCandidates(traded),
    all: rankPeakCandidates(all),
    unreached: rankPeakCandidates(unreached),
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

/** 오늘 행 push — ask 쪽 pushTodayAskPeak 미러(사유는 그쪽 주석 참조). */
function pushTodayBidPeak(out: BidPeak[], todayKst: string, families: PeakFamilies): BidPeak[] {
  const traded = families.traded[0];
  if (traded) {
    out.push(attachFamilies(bidPeakFromCandidate(todayKst, traded), families));
  } else if (families.all.length > 0) {
    out.push(attachFamilies({
      date: todayKst,
      price: null,
      qty: null,
      t_ms: null,
      max_price: null,
      max_qty: null,
      max_t_ms: null,
    }, families));
  }
  return out;
}

function attachFamilies(
  peak: BidPeak,
  families: PeakFamilies,
): BidPeak {
  return {
    ...peak,
    traded_peaks: families.traded,
    traded_max_peaks: families.traded,
    all_peaks: families.all,
    all_max_peaks: families.all,
    unreached_price: families.unreached[0]?.price ?? null,
    unreached_qty: families.unreached[0]?.qty ?? null,
    unreached_t_ms: families.unreached[0]?.t_ms ?? null,
    unreached_peaks: families.unreached,
  };
}

/** classify 결과 + 백엔드 패밀리 → 최종 패밀리 조립. 배치(mergedBidFamilies)와
 *  증분(useDayBidPeaks) 경로가 공유하는 유일한 조립 구현. */
function bidFamiliesFromClassified(
  classified: PeakWallClassification,
  backend: PeakFamilies,
): PeakFamilies {
  const traded = mergeRankedCandidates(classified.touched, backend.traded);
  const all = mergeRankedCandidates(classified.all, backend.all, traded);
  // unreached 는 백엔드를 병합하지 않는다 — PeakFamilies 필드 주석 참조(재필터가 요점).
  return { traded, all, unreached: rankPeakCandidates(classified.unreached) };
}

function mergedBidFamilies(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  todayBidPeak: LiveTodayBidPeak | null,
  sessionOpenMs: number,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
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
    ...toWallEventsFromOrderbooks(filteredOb, 'bid', sessionOpenMs),
    ...filterCandidates(backend.all),
    ...filterCandidates(backend.traded),
    ...filterCandidates(backend.unreached),
  ]);
  // 미도달 극값 — ask 쪽 mergedAskFamilies 의 같은 자리 주석 참조(cutoff 는 캔들 근사).
  const dayExtremeArg = visibleTimeCutoff
    ? dayExtremeFromCandles(todayCandles, 'bid', sessionOpenMs, visibleTimeCutoff.tMs)
    : todayBidPeak?.day_extreme ?? null;
  const classified = classifyBidWallEvents(sourceEvents, touchTicks, dayExtremeArg);
  if (visibleTimeCutoff) {
    return {
      traded: rankPeakCandidates(classified.touched),
      all: rankPeakCandidates(classified.all),
      unreached: rankPeakCandidates(classified.unreached),
    };
  }
  return bidFamiliesFromClassified(classified, backend);
}
export function buildTodayTradedBidPeak(todayBidPeak: LiveTodayBidPeak | null): BidPeak | null {
  const families = backendPeakFamilies(todayBidPeak);
  const date = todayBidPeak?.date;
  const traded = families.traded[0];
  if (!date || !traded) return null;
  return attachFamilies(bidPeakFromCandidate(date, traded), families);
}

export function deriveDayBidPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  sessionOpenMs: number,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): BidPeak[] {
  void code;
  const families = mergedBidFamilies(
    ob, trade, todayBidPeak, sessionOpenMs, visibleTimeCutoff, todayCandles,
  );
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayBidPeak(out, todayKst, families);
}

export function deriveDayBidPeaksIncremental(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  sessionOpenMs: number,
  todayBidPeak: LiveTodayBidPeak | null,
): BidPeak[] {
  const backend = backendPeakFamilies(todayBidPeak);
  const classified = source.update(ob, trade, sessionOpenMs, [
    ...backend.all,
    ...backend.traded,
    ...backend.unreached,
  ], todayBidPeak?.day_extreme ?? null);
  const families = bidFamiliesFromClassified(classified, backend);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayBidPeak(out, todayKst, families);
}
/** mergedBidFamilies 의 cutoff 분기와 동일(증분 경로 전용). */
function bidFamiliesFromClassifiedCutoff(classified: PeakWallClassification): PeakFamilies {
  return {
    traded: rankPeakCandidates(classified.touched),
    all: rankPeakCandidates(classified.all),
    unreached: rankPeakCandidates(classified.unreached),
  };
}

/** deriveDayBidPeaks(cutoff) 의 증분판. */
export function deriveDayBidPeaksIncrementalAsOf(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  sessionOpenMs: number,
  todayBidPeak: LiveTodayBidPeak | null,
  cutoffMs: number,
  /** 미도달 극값의 cutoff 근사 원천(오늘 캔들) — ask 쪽과 동일. */
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): BidPeak[] {
  const backend = backendPeakFamilies(todayBidPeak);
  const classified = source.updateAsOf(ob, trade, [
    ...backend.all,
    ...backend.traded,
    ...backend.unreached,
  ], cutoffMs, sessionOpenMs,
  dayExtremeFromCandles(todayCandles, 'bid', sessionOpenMs, cutoffMs));
  const families = bidFamiliesFromClassifiedCutoff(classified);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayBidPeak(out, todayKst, families);
}

export function useDayBidPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  sessionOpenMs: number,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): BidPeak[] {
  void code;
  void todayCandles;
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('bid');
  return useMemo(
    () => deriveDayBidPeaksIncremental(sourceRef.current!, ob, trade, seeds, todayKst, sessionOpenMs, todayBidPeak),
    [ob, trade, seeds, todayKst, sessionOpenMs, todayBidPeak],
  );
}
