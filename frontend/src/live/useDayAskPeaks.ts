import { useMemo, useRef } from 'react';
import type { AskPeak, AskPeakCandidate, Candle } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';
import {
  classifyAskWallEvents,
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
function pushTodayAskPeak(out: AskPeak[], todayKst: string, families: PeakFamilies): AskPeak[] {
  const traded = families.traded[0];
  if (traded) {
    out.push(attachFamilies(askPeakFromCandidate(todayKst, traded), families));
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
  peak: AskPeak,
  families: PeakFamilies,
): AskPeak {
  return {
    ...peak,
    traded_peaks: families.traded,
    traded_max_peaks: families.traded,
    // 오늘 라이브 경로의 기록 폴백 — 클라이언트는 접속 이후 이벤트만 보므로 완전한
    // 기록 시퀀스를 모른다. traded top-3 을 그대로 실으면 계단이 종전(수정 전 오늘
    // 동작)과 동일하게 유지된다. 오늘의 완전한 기록은 서버 상태 확장 후속.
    traded_record_peaks: families.traded,
    traded_record_max_peaks: families.traded,
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
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
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
    ...toWallEventsFromOrderbooks(filteredOb, 'ask', sessionOpenMs),
    ...filterCandidates(backend.all),
    ...filterCandidates(backend.traded),
    ...filterCandidates(backend.unreached),
  ]);
  // 미도달 극값 — cutoff 판은 오늘 캔들 ≤ cutoff 로 근사(백엔드 day_extreme 은 "지금"
  // 기준이라 과거 cutoff 에 쓰면 미래 체결이 섞인다), no-cutoff 는 백엔드 스냅샷.
  const dayExtremeArg = visibleTimeCutoff
    ? dayExtremeFromCandles(todayCandles, 'ask', sessionOpenMs, visibleTimeCutoff.tMs)
    : todayAskPeak?.day_extreme ?? null;
  const classified = classifyAskWallEvents(sourceEvents, touchTicks, dayExtremeArg);
  if (visibleTimeCutoff) {
    return {
      traded: rankPeakCandidates(classified.touched),
      all: rankPeakCandidates(classified.all),
      unreached: rankPeakCandidates(classified.unreached),
    };
  }
  return askFamiliesFromClassified(classified, backend);
}
export function buildTodayTradedAskPeak(todayAskPeak: LiveTodayAskPeak | null): AskPeak | null {
  const families = backendPeakFamilies(todayAskPeak);
  const date = todayAskPeak?.date;
  const traded = families.traded[0];
  if (!date || !traded) return null;
  return attachFamilies(askPeakFromCandidate(date, traded), families);
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
  visibleTimeCutoff: VisibleTimeCutoff | null = null,
): AskPeak[] {
  void code;
  const families = mergedAskFamilies(
    ob, trade, todayAskPeak, sessionOpenMs, visibleTimeCutoff, todayCandles,
  );
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayAskPeak(out, todayKst, families);
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
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayAskPeak(out, todayKst, families);
}
/** classify 결과 → cutoff 패밀리 조립. mergedAskFamilies 의 cutoff 분기(라인 174-185)와
 *  동일: backend 를 별도 병합하지 않고(이미 sourceEvents/extras 로 접힘) 분류 결과를 랭크만
 *  한다. 증분 경로 전용 — no-cutoff 의 askFamiliesFromClassified 와 구분된다. */
function askFamiliesFromClassifiedCutoff(classified: PeakWallClassification): PeakFamilies {
  return {
    traded: rankPeakCandidates(classified.touched),
    all: rankPeakCandidates(classified.all),
    unreached: rankPeakCandidates(classified.unreached),
  };
}

/** deriveDayAskPeaks(cutoff) 의 증분판. source.updateAsOf 가 ob/trade 재스캔 대신 누적
 *  구조를 cutoff 기준으로 분류하고, 조립은 배치 cutoff 분기와 동일. */
export function deriveDayAskPeaksIncrementalAsOf(
  source: IncrementalPeakWallSource,
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  sessionOpenMs: number,
  todayAskPeak: LiveTodayAskPeak | null,
  cutoffMs: number,
  /** 미도달 극값의 cutoff 근사 원천(오늘 캔들) — mergedAskFamilies cutoff 분기와 동일. */
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): AskPeak[] {
  const backend = backendPeakFamilies(todayAskPeak);
  const classified = source.updateAsOf(ob, trade, [
    ...backend.all,
    ...backend.traded,
    ...backend.unreached,
  ], cutoffMs, sessionOpenMs,
  dayExtremeFromCandles(todayCandles, 'ask', sessionOpenMs, cutoffMs));
  const families = askFamiliesFromClassifiedCutoff(classified);
  const out = seeds.filter((peak) => peak.date !== todayKst);
  return pushTodayAskPeak(out, todayKst, families);
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
  void code;
  void todayCandles;
  const sourceRef = useRef<IncrementalPeakWallSource | null>(null);
  if (sourceRef.current === null) sourceRef.current = new IncrementalPeakWallSource('ask');
  return useMemo(
    () => deriveDayAskPeaksIncremental(sourceRef.current!, ob, trade, seeds, todayKst, sessionOpenMs, todayAskPeak),
    [ob, trade, seeds, todayKst, sessionOpenMs, todayAskPeak],
  );
}
