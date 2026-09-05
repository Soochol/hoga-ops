import { useMemo, useRef } from 'react';
import type { AskPeak, AskPeakCandidate, Candle } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import {
  classifyAskWallEvents,
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
  /** 미도달 벽 — 당일 고가가 지배하지 못한 벽. 백엔드 시드도 extras 로 분류기를
   *  거쳐 **현재 극값으로 재필터**된 결과라, 다른 패밀리처럼 백엔드를 별도 병합하지
   *  않는다(병합하면 이미 도달한 시드가 극값 검사 없이 되살아난다). */
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
  peak: LiveTodayAskPeak | null,
  prefix: 'traded' | 'all' | 'unreached',
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
  const all = todayAskPeak?.all_peaks?.length
    ? todayAskPeak.all_peaks
    : [candidateFromPrefix(todayAskPeak, 'all')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  const unreached = todayAskPeak?.unreached_peaks?.length
    ? todayAskPeak.unreached_peaks
    : [candidateFromPrefix(todayAskPeak, 'unreached')].filter((candidate): candidate is AskPeakCandidate => candidate !== null);
  return {
    traded: rankPeakCandidates(traded),
    all: rankPeakCandidates(all),
    unreached: rankPeakCandidates(unreached),
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

/** 오늘 행 push — traded rank-1 이 base carrier. traded 가 없어도 all 패밀리가 있으면
 *  **빈 carrier(null)** 로 행을 만든다: 「전체 최대벽」 선(터치 무관)은 첫 터치 전에도
 *  존재해야 한다. null carrier 는 체결된 벽 선에서 후보 없음으로 걸러진다
 *  (expandBaselinePeaks 의 scalar 폴백이 null 을 버린다). 세 derive 판이 이 꼬리를
 *  공유한다 — 갈라지면 배치·증분 동등성이 깨진다. */
function pushTodayAskPeak(
  out: AskPeak[],
  todayKst: string,
  families: PeakFamilies,
  records: PeakRecordSeries,
  bars: PeakBarSeries,
): AskPeak[] {
  const traded = families.traded[0];
  if (traded) {
    out.push(attachFamilies(askPeakFromCandidate(todayKst, traded), families, records, bars));
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
  peak: AskPeak,
  families: PeakFamilies,
  /** **필수 인자다** — 기본값을 주면 새 호출부가 조용히 기록 없이 태어난다
   *  (`buildPeakWallOverlaySegments` 의 maFilter 가 같은 이유로 필수다).
   *  기록을 안 쓰는 자리는 `EMPTY_PEAK_RECORD_SERIES` 를 명시한다. */
  records: PeakRecordSeries,
  bars: PeakBarSeries,
): AskPeak {
  return {
    ...peak,
    traded_peaks: families.traded,
    traded_max_peaks: families.traded,
    // 기록 갱신 시퀀스 — `buildPeakRecordSeries` 가 seed(개장~프로모션) + 라이브 스냅샷
    // (서버 상태 당일 전체)에서 모은 값이다. 여기에 top-3 을 넣으면 계단의 왼쪽 끝이
    // 순위 갱신마다 오른쪽으로 후퇴한다(이 수정 전의 증상). 비면 `expandBaselinePeaks`
    // 가 top-3 으로 떨어지므로 구백엔드에서도 종전 동작이 유지된다.
    traded_record_peaks: records.close,
    traded_record_max_peaks: records.max,
    // 분별 최대 — 같은 두 출처(`buildPeakBarSeries`)에서 왔고, 비면 봉별 모드가
    // 그리지 않는다(top-3 폴백이 **없다** — 그 모듈 docstring 참조).
    traded_bar_peaks: bars.close,
    traded_bar_max_peaks: bars.max,
    all_peaks: families.all,
    all_max_peaks: families.all,
    unreached_price: families.unreached[0]?.price ?? null,
    unreached_qty: families.unreached[0]?.qty ?? null,
    unreached_t_ms: families.unreached[0]?.t_ms ?? null,
    unreached_peaks: families.unreached,
  };
}

/** classify 결과 + 백엔드 패밀리 → 최종 패밀리 조립. 배치(mergedAskFamilies)와
 *  증분(useDayAskPeaks) 경로가 공유하는 유일한 조립 구현 — 여기가 갈라지면 동등성이
 *  깨지므로 반드시 한 곳만 둔다. */
function askFamiliesFromClassified(
  classified: PeakWallClassification,
  backend: PeakFamilies,
): PeakFamilies {
  const traded = mergeRankedCandidates(classified.touched, backend.traded);
  const all = mergeRankedCandidates(classified.all, backend.all, traded);
  // unreached 는 백엔드를 병합하지 않는다 — PeakFamilies 필드 주석 참조(재필터가 요점).
  return { traded, all, unreached: rankPeakCandidates(classified.unreached) };
}

function mergedAskFamilies(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  todayAskPeak: LiveTodayAskPeak | null,
  sessionOpenMs: number,
): PeakFamilies {
  const backend = backendPeakFamilies(todayAskPeak);
  const touchTicks = toTouchTicksFromTrades(trade);
  const sourceEvents = uniqueCandidates([
    ...toWallEventsFromOrderbooks(ob, 'ask', sessionOpenMs),
    ...backend.all,
    ...backend.traded,
    ...backend.unreached,
  ]);
  const classified = classifyAskWallEvents(
    sourceEvents, touchTicks, todayAskPeak?.day_extreme ?? null,
  );
  return askFamiliesFromClassified(classified, backend);
}

export function deriveDayAskPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  sessionOpenMs: number,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): AskPeak[] {
  void code;
  void todayCandles;
  const families = mergedAskFamilies(ob, trade, todayAskPeak, sessionOpenMs);
  const seed = todaySeedRow(seeds, todayKst);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayAskPeak(out, todayKst, families, buildPeakRecordSeries(seed, todayAskPeak), buildPeakBarSeries(seed, todayAskPeak));
}

/** deriveDayAskPeaks의 증분판(no-cutoff 전용). source가 ob/trade 스캔을 누적으로
 *  대체하고, 조립은 배치와 동일한 askFamiliesFromClassified를 쓴다. */
export function deriveDayAskPeaksIncremental(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  sessionOpenMs: number,
  todayAskPeak: LiveTodayAskPeak | null,
): AskPeak[] {
  const backend = backendPeakFamilies(todayAskPeak);
  const classified = source.update(ob, trade, sessionOpenMs, [
    ...backend.all,
    ...backend.traded,
    ...backend.unreached,
  ], todayAskPeak?.day_extreme ?? null);
  const families = askFamiliesFromClassified(classified, backend);
  const seed = todaySeedRow(seeds, todayKst);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayAskPeak(out, todayKst, families, buildPeakRecordSeries(seed, todayAskPeak), buildPeakBarSeries(seed, todayAskPeak));
}
export function useDayAskPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  sessionOpenMs: number,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): AskPeak[] {
  void todayCandles;
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('ask');
  // 접속 이후 기록 누적 — **derive 밖**이다(사유는 `PeakRecordAccumulator` 주석: derive 는
  // 배치판과 값이 같아야 하는데 배치는 축출된 기록을 원리적으로 못 가진다).
  const recordsRef = useRef<PeakRecordAccumulator | null>(null);
  if (recordsRef.current === null) recordsRef.current = new PeakRecordAccumulator();
  return useMemo(
    () => withSessionRecords(
      deriveDayAskPeaksIncremental(sourceRef.current!, ob, trade, seeds, todayKst, sessionOpenMs, todayAskPeak),
      recordsRef.current!,
      todayKst,
      `${code}|${todayKst}|${sessionOpenMs}`,
    ),
    [ob, trade, seeds, todayKst, sessionOpenMs, todayAskPeak, code],
  );
}
