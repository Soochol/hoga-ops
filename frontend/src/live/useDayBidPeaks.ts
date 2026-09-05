import { useMemo, useRef } from 'react';
import type { AskPeakCandidate, BidPeak, Candle } from '../api/types';
import type { LiveTodayBidPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import {
  classifyBidWallEvents,
  rankPeakCandidates,
  toTouchTicksFromTrades,
  toWallEventsFromOrderbooks,
  type PeakWallClassification,
} from './peakWallEventClassifier';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import {
  buildPeakRecordSeries,
  todaySeedRow,
  withSessionRecords,
  PeakRecordAccumulator,
  type PeakRecordSeries,
} from './peakWallRecordSeries';
import { buildPeakBarSeries, type PeakBarSeries } from './peakWallBarSeries';

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
function pushTodayBidPeak(
  out: BidPeak[],
  todayKst: string,
  families: PeakFamilies,
  records: PeakRecordSeries,
  bars: { traded: PeakBarSeries; all: PeakBarSeries; unreached: PeakBarSeries },
): BidPeak[] {
  const traded = families.traded[0];
  if (traded) {
    out.push(attachFamilies(bidPeakFromCandidate(todayKst, traded), families, records, bars));
  } else if (families.all.length > 0) {
    out.push(attachFamilies({
      date: todayKst,
      price: null,
      qty: null,
      t_ms: null,
      max_price: null,
      max_qty: null,
      max_t_ms: null,
    }, families, records, bars));
  }
  return out;
}

function attachFamilies(
  peak: BidPeak,
  families: PeakFamilies,
  /** **필수 인자다** — 기본값을 주면 새 호출부가 조용히 기록 없이 태어난다
   *  (`buildPeakWallOverlaySegments` 의 maFilter 가 같은 이유로 필수다).
   *  기록을 안 쓰는 자리는 `EMPTY_PEAK_RECORD_SERIES` 를 명시한다. */
  records: PeakRecordSeries,
  bars: { traded: PeakBarSeries; all: PeakBarSeries; unreached: PeakBarSeries },
): BidPeak {
  return {
    ...peak,
    traded_peaks: families.traded,
    traded_max_peaks: families.traded,
    // 기록 갱신 시퀀스 — ask 쪽 attachFamilies 와 **같은 배선**이다. 종전엔 이 두 줄이
    // 매수에만 통째로 없었고(매도는 top-3 을 실었다), 결과가 같아 드리프트가 안 보였다.
    traded_record_peaks: records.close,
    traded_record_max_peaks: records.max,
    // 분별 최대 — 같은 두 출처(`buildPeakBarSeries`)에서 왔고, 비면 봉별 모드가
    // 그리지 않는다(top-3 폴백이 **없다** — 그 모듈 docstring 참조).
    traded_bar_peaks: bars.traded.close,
    traded_bar_max_peaks: bars.traded.max,
    // 전체 계열도 같은 조립에서 온다(`buildPeakBarSeries` 의 family 인자) — 두 계열이
    // 한 pane 의 같은 모드를 공유하므로 한쪽만 배선하면 그 칸만 조용히 빈다.
    all_bar_peaks: bars.all.close,
    all_bar_max_peaks: bars.all.max,
    // 미도달은 축이 하나라 close 만 쓴다(양쪽에 같은 배열이 들어 있다).
    unreached_bar_peaks: bars.unreached.close,
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
): PeakFamilies {
  const backend = backendPeakFamilies(todayBidPeak);
  const touchTicks = toTouchTicksFromTrades(trade);
  const sourceEvents = uniqueCandidates([
    ...toWallEventsFromOrderbooks(ob, 'bid', sessionOpenMs),
    ...backend.all,
    ...backend.traded,
    ...backend.unreached,
  ]);
  const classified = classifyBidWallEvents(
    sourceEvents, touchTicks, todayBidPeak?.day_extreme ?? null,
  );
  return bidFamiliesFromClassified(classified, backend);
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
): BidPeak[] {
  void code;
  void todayCandles;
  const families = mergedBidFamilies(ob, trade, todayBidPeak, sessionOpenMs);
  const seed = todaySeedRow(seeds, todayKst);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayBidPeak(out, todayKst, families, buildPeakRecordSeries(seed, todayBidPeak), {
    traded: buildPeakBarSeries(seed, todayBidPeak, 'traded'),
    all: buildPeakBarSeries(seed, todayBidPeak, 'all'),
    unreached: buildPeakBarSeries(seed, todayBidPeak, 'unreached'),
  });
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
  const seed = todaySeedRow(seeds, todayKst);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayBidPeak(out, todayKst, families, buildPeakRecordSeries(seed, todayBidPeak), {
    traded: buildPeakBarSeries(seed, todayBidPeak, 'traded'),
    all: buildPeakBarSeries(seed, todayBidPeak, 'all'),
    unreached: buildPeakBarSeries(seed, todayBidPeak, 'unreached'),
  });
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
  void todayCandles;
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('bid');
  // 접속 이후 기록 누적 — **derive 밖**이다(사유는 `PeakRecordAccumulator` 주석: derive 는
  // 배치판과 값이 같아야 하는데 배치는 축출된 기록을 원리적으로 못 가진다).
  const recordsRef = useRef<PeakRecordAccumulator | null>(null);
  if (recordsRef.current === null) recordsRef.current = new PeakRecordAccumulator();
  return useMemo(
    () => withSessionRecords(
      deriveDayBidPeaksIncremental(sourceRef.current!, ob, trade, seeds, todayKst, sessionOpenMs, todayBidPeak),
      recordsRef.current!,
      todayKst,
      `${code}|${todayKst}|${sessionOpenMs}`,
    ),
    [ob, trade, seeds, todayKst, sessionOpenMs, todayBidPeak, code],
  );
}
