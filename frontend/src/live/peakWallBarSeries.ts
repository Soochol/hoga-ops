// 오늘 최대벽의 **분별 최대** 조립 — 매도·매수 공용(순수).
//
// 최대벽 강도 pane 의 **봉별 모드**(「매 분봉에서 가장 크게 체결된 벽」) 입력이다.
// `peakWallRecordSeries`(누적 계단)와 **같은 두 출처를 같은 방식으로** 합치지만,
// 접기 규칙과 보존 전략이 다르다 — 아래 두 절이 그 차이다.
//
// ## 접기: 분당 하나 (prefix maxima 가 아니다)
//
// 기록 시퀀스는 시간순 running max 라 같은 분에 여러 항목이 남을 수 있다. 이쪽은
// **분마다 최대 하나**이고, 그것이 백엔드 규약과 같다(`_peak_bar_max_sequence` ·
// `_TodaySidePeakState._offer_bar_max`). 두 출처가 같은 분을 다르게 관측하면
// (seed 는 프로모션까지, 라이브는 서버 상태 전체) **큰 쪽이 그 분의 값**이다 —
// 둘 다 부분 관측이므로 max 가 정답이다.
//
// ## 왜 세션 누적기가 없는가 — **원리적으로 못 만든다**
//
// `PeakRecordAccumulator` 는 "기록을 세운 벽은 그 순간 반드시 1위였으므로 화면에
// 실린 top-3 에 반드시 담긴다" 는 성질에 기댄다. 봉별 최대에는 **그 성질이 없다**:
// 어떤 분의 최대 벽은 그날 top-3 에 못 드는 것이 오히려 보통이다. top-3 을 아무리
// 모아도 지나간 분의 값을 복원할 수 없으므로 누적기를 두지 않는다.
//
// 결과로 남는 한계: 이 계열의 최근 구간은 **`/api/range` 폴링(5분) + 프로모션(5분)
// 만큼 늦게** 채워진다(라이브 스냅샷은 마운트 1회라 그 뒤를 못 본다). 봉별 모드가
// 답하는 질문이 "어느 봉에 큰 벽이 체결됐나" 라 과거 구간을 읽는 용도이고, 최근
// 10분이 늦게 차는 것은 그 용도에서 감당 가능하다고 판단했다(2026-09-05).
// ⚠ 이것을 "버그" 로 다시 보고받으면 고칠 자리는 누적기가 아니라 **라이브 스냅샷의
// 갱신 주기**다.

import type { AskPeakCandidate } from '../api/types';

/** 분별 최대 계열 — `PeakRecordSeries` 와 같은 두 축 모양이다. */
export type PeakBarSeries = {
  /** rep 축(봉 대표) — `traded_bar_peaks` 로 나간다. */
  close: AskPeakCandidate[];
  /** cont 축(연속) — `traded_bar_max_peaks` 로 나간다. */
  max: AskPeakCandidate[];
};

/** 비었을 때의 **공유** 인스턴스 — 매번 새 객체를 만들면 소비처 memo 가 흔들린다. */
export const EMPTY_PEAK_BAR_SERIES: PeakBarSeries = { close: [], max: [] };

/** `/api/range` seed 가 나르는 두 축. 과거일과 같은 계산이라 rep/cont 가 따로 있다. */
type BarSeed = {
  traded_bar_peaks?: AskPeakCandidate[];
  traded_bar_max_peaks?: AskPeakCandidate[];
};

/** 라이브 스냅샷이 나르는 한 축(축 구분 없음 — `liveSeries.ts` 필드 주석). */
type BarLive = {
  traded_bar_peaks?: AskPeakCandidate[];
};

const ONE_MINUTE_MS = 60_000;

/** 분당 최대 하나로 접어 시간순 정렬. 동률은 **먼저 온 것을 유지**한다(strict `>`) —
 *  백엔드 `_offer_bar_max`·`_larger_peak` 규약 미러. */
function mergeBarCandidates(
  ...groups: ReadonlyArray<readonly AskPeakCandidate[] | null | undefined>
): AskPeakCandidate[] {
  const best = new Map<number, AskPeakCandidate>();
  for (const candidate of groups.flatMap((group) => group ?? [])) {
    if (!Number.isFinite(candidate.t_ms) || !Number.isFinite(candidate.qty)) continue;
    const minute = Math.floor(candidate.t_ms / ONE_MINUTE_MS);
    const current = best.get(minute);
    if (current === undefined || candidate.qty > current.qty) best.set(minute, candidate);
  }
  return [...best.values()].sort((a, b) => a.t_ms - b.t_ms);
}

/**
 * 오늘 행의 분별 최대를 **두 출처에서** 모은다 — `buildPeakRecordSeries` 와 같은 짝.
 *
 * 1. `/api/range` 오늘 seed — 개장 ~ 마지막 프로모션. 두 축이 따로 온다.
 * 2. 라이브 스냅샷 — 서버 상태의 당일 전체. 축 구분이 없어 **양쪽에 같은 배열**.
 *
 * 둘 다 비면 빈 계열이고, 그때 봉별 모드는 아무것도 그리지 않는다 — 계단 모드처럼
 * top-3 으로 떨어지는 폴백이 **없다**: top-3 은 그날 최종 크기순이라 봉별 값이
 * 아니고, 그걸 그리면 세 봉만 값이 있는 **틀린 화면**이 된다. 구백엔드나 옵트인이
 * 꺼진 창에서 빈 pane 이 나오는 것이 그 대안보다 정직하다.
 */
export function buildPeakBarSeries(
  seed: BarSeed | null,
  live: BarLive | null,
): PeakBarSeries {
  const liveBars = live?.traded_bar_peaks;
  return {
    close: mergeBarCandidates(seed?.traded_bar_peaks, liveBars),
    max: mergeBarCandidates(seed?.traded_bar_max_peaks, liveBars),
  };
}
