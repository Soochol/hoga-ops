import type { IRange, Time } from 'lightweight-charts';
import type { AskPeak, AskPeakCandidate, BidPeak, Candle, PeakBase } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { realMsToYyyymmdd } from './liveDateTime';

export type VisibleTimeCutoff = {
  date: string;
  tMs: number;
};

/** ⚠ 종전엔 `side: 'ask' | 'bid'` 가 있었는데 본문이 `void options.side` 로 **버리고
 *  있었다**(2026-08-23 제거). 컷오프는 후보 시각만 보므로 방향과 무관하다. 그 죽은
 *  인자가 매도·매수 호출부를 텍스트상 다르게 만들어, 두 파일이 실제로는 같은 계산인데도
 *  달라 보이게 한 원인 중 하나였다. */
type CutoffOptions = {
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
  if (!candidates) return candidates;
  if (candidates.length === 0) return [];
  return candidates.filter((candidate) => candidate.t_ms <= cutoff.tMs);
}

/**
 * 두 컷오프가 **같은 봉을 가리키는가**.
 *
 * `rightmostVisibleCandleCutoff` 는 호출마다 **새 객체**를 낸다. 그래서 그대로 setState 하면
 * 값이 그대로여도 identity 가 달라 재렌더가 난다 — 팬 한 번은 프레임을 수십 개 내는데,
 * 그 대부분은 **오른쪽 끝 봉이 그대로**다(왼쪽으로 밀거나 봉 하나 안에서 줌할 때). 호출부가
 * 이 함수로 걸러 같으면 이전 참조를 유지하면 React 가 그 프레임의 재렌더를 통째로 건너뛴다.
 */
export function sameVisibleTimeCutoff(
  a: VisibleTimeCutoff | null,
  b: VisibleTimeCutoff | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.date === b.date && a.tMs === b.tMs;
}

export function rightmostVisibleCandleCutoff(
  candles: readonly Candle[],
  visibleRange: IRange<Time> | null,
  axis: VirtualAxis,
  bucketMs?: number,
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
  if (ans < 0) return null;
  const selected = candles[ans];
  if (!selected) return null;
  const bucketEndMs = bucketMs && bucketMs > 0
    ? selected.ts_ms + bucketMs - 1
    : selected.ts_ms;
  return { date: realMsToYyyymmdd(selected.ts_ms), tMs: bucketEndMs };
}

function candidateFromPeak(peak: PeakBase, intraMax: boolean): AskPeakCandidate | null {
  const price = intraMax ? peak.max_price : peak.price;
  const qty = intraMax ? peak.max_qty : peak.qty;
  const tMs = finiteTime(intraMax ? peak.max_t_ms : peak.t_ms);
  if (
    typeof price !== 'number'
    || !Number.isFinite(price)
    || typeof qty !== 'number'
    || !Number.isFinite(qty)
    || tMs === null
  ) return null;
  return { price, qty, t_ms: tMs };
}

function maxCandidateFromPeak(peak: PeakBase, intraMax: boolean): AskPeakCandidate | null {
  return candidateFromPeak(peak, intraMax);
}

function chooseCandidate(
  peak: PeakWithCandidates,
  cutoff: VisibleTimeCutoff,
  intraMax: boolean,
): { close: AskPeakCandidate; max: AskPeakCandidate } | null {
  const closeCandidates = peak.traded_peaks === undefined
    ? [candidateFromPeak(peak, false)].filter((candidate): candidate is AskPeakCandidate => candidate !== null)
    : peak.traded_peaks;
  const maxCandidates = peak.traded_max_peaks === undefined
    ? [maxCandidateFromPeak(peak, true)].filter((candidate): candidate is AskPeakCandidate => candidate !== null)
    : peak.traded_max_peaks;
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
  prefix: 'all',
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
      ...cutoffNullableTriple(peak, cutoff, 'all'),
    });
  }
  return out;
}

/**
 * 컷오프 state 의 다음 값 — **같은 봉이면 이전 참조를 그대로 돌려준다.**
 *
 * `rightmostVisibleCandleCutoff` 가 호출마다 새 객체를 내므로, 그 결과를 곧장 setState 하면
 * 값이 그대로여도 재렌더가 난다. 팬 한 번은 프레임을 수십 개 내는데 그 대부분은 오른쪽 끝
 * 봉이 그대로다(왼쪽으로 밀거나 봉 하나 안에서 줌할 때) — 그 프레임들의 재렌더가 통째로
 * 낭비였다. React 는 `Object.is` 로 같으면 그 갱신을 버리므로, 이전 참조를 돌려주는 것만으로
 * 재렌더가 사라진다.
 *
 * 순수 함수로 떼어 둔 이유: 「참조가 보존되는가」를 컴포넌트 없이 직접 잴 수 있어야 한다.
 * 호출부에 인라인으로 두면 그 비교를 지워도 아무 테스트도 빨개지지 않는다.
 */
export function nextVisibleTimeCutoff(
  prev: VisibleTimeCutoff | null,
  candles: readonly Candle[],
  visibleRange: IRange<Time> | null,
  axis: VirtualAxis,
  bucketMs?: number,
): VisibleTimeCutoff | null {
  const next = rightmostVisibleCandleCutoff(candles, visibleRange, axis, bucketMs);
  return sameVisibleTimeCutoff(prev, next) ? prev : next;
}
