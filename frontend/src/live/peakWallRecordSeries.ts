// 오늘 최대벽의 **기록 갱신 시퀀스** 조립 — 매도·매수 공용(순수).
//
// 기록 시퀀스는 "그 시점까지 체결된 벽 중 최대" 의 시간축 복원이고, 최대벽 강도 pane
// 계단의 유일한 정직한 입력이다. `traded_peaks`(최종 크기순 top-3)와 **축이 다르다**:
// 벽은 장중에 커지는 경향이라 top-3 이 오후에 몰리면 오전 기록이 전부 잘린다.
//
// ## 왜 별도 모듈인가
//
// `useDayAskPeaks`/`useDayBidPeaks` 는 서로의 거의 완전한 복사본이고, **이 필드가
// 실제로 갈라져 있었다**: 매도는 기록 자리에 top-3 을 실었고 매수는 아예 안 실었다.
// 결과는 같았지만(둘 다 top-3 폴백) 조립이 두 벌이라 한쪽만 고치는 수정이 가능했다.
// 한 벌만 두면 그 비대칭이 숨을 곳이 없다(`peakWallSegments` 머리말과 같은 근거).

import type { AskPeakCandidate } from '../api/types';

/**
 * 기록 갱신 시퀀스 — **랭킹도 상한도 없는** 시간순 계열.
 *
 * `PeakFamilies` 와 같은 그릇에 담지 않는 이유: 저기 담기는 순간 다른 필드처럼
 * `rankPeakCandidates` 를 태우고 싶어지는데, 그러면 top-3 으로 잘려 **이 계열이
 * 존재할 이유가 사라진다**. 타입을 갈라 두면 그 실수가 눈에 띈다.
 */
export type PeakRecordSeries = {
  /** rep 축(봉 대표) — `traded_record_peaks` 로 나간다. */
  close: AskPeakCandidate[];
  /** cont 축(연속) — `traded_record_max_peaks` 로 나간다. */
  max: AskPeakCandidate[];
};

/** 기록이 전혀 없을 때의 **공유** 빈 계열 — 매번 새 객체를 만들면 소비처 memo 가 흔들린다. */
export const EMPTY_PEAK_RECORD_SERIES: PeakRecordSeries = { close: [], max: [] };

/** `/api/range` seed 가 나르는 두 축. 과거일과 같은 계산이라 rep/cont 가 **따로** 있다. */
type RecordSeed = {
  traded_record_peaks?: AskPeakCandidate[];
  traded_record_max_peaks?: AskPeakCandidate[];
};

/** 라이브 스냅샷이 나르는 한 축. 축 구분이 없는 이유는 `liveSeries.ts` 필드 주석 참조. */
type RecordLive = {
  traded_record_peaks?: AskPeakCandidate[];
};

function candidateKey(candidate: AskPeakCandidate): string {
  return `${candidate.price}:${candidate.qty}:${candidate.t_ms}`;
}

/** 기록 후보 병합 — **상한을 걸지 않는다**. 랭커를 태우면 top-3 으로 잘린다.
 *  정렬은 시각 오름차순(동시각은 큰 잔량 먼저) — 계단 빌더가 다시 정렬하지만,
 *  값을 눈으로 읽는 테스트·디버깅이 시간축을 기대하므로 여기서 맞춰 둔다. */
function mergeRecordCandidates(
  ...groups: ReadonlyArray<readonly AskPeakCandidate[] | null | undefined>
): AskPeakCandidate[] {
  const out: AskPeakCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of groups.flatMap((group) => group ?? [])) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out.sort((a, b) => a.t_ms - b.t_ms || b.qty - a.qty);
}

/**
 * `/api/range` seed 의 **오늘 행**. 오늘 행은 라이브 파생이 통째로 대체하지만
 * (`deriveDay*Peaks` 의 `seeds.filter`), 기록 시퀀스만은 건져 낸다 — 개장부터 마지막
 * 프로모션까지의 오전 기록이 거기에만 있다.
 */
export function todaySeedRow<T extends { date: string }>(
  seeds: readonly T[],
  todayKst: string,
): T | null {
  return seeds.find((row) => row.date === todayKst) ?? null;
}

/**
 * 오늘 행의 기록 시퀀스를 **두 출처에서** 모은다.
 *
 * 1. `/api/range` 오늘 seed — 개장 ~ 마지막 프로모션(디스크 캡처 유래). 두 축이 따로.
 * 2. 라이브 스냅샷 — 서버 상태가 들고 있는 당일 전체. 장중 재기동 시엔 오늘 JSONL
 *    재생본이 `merge_from` 으로 흡수돼 오전이 복원된다. 축 구분이 없어 **양쪽에 같은
 *    배열**을 싣는다.
 *
 * 둘을 합치는 것이 요점이다 — 어느 한쪽만으로는 구멍이 남는다: seed 는 마지막 프로모션
 * 이후를 모르고, 라이브는 서버가 그 종목을 구독하기 전(또는 무자격 휴면)을 모른다.
 *
 * 둘 다 비면 빈 계열이고, 그때 계단은 종전대로 `traded_peaks`(top-3)로 떨어진다
 * (`expandBaselinePeaks` 가 기록 ∪ top-3 을 후보로 쓴다) — 구백엔드 동작 보존.
 */
export function buildPeakRecordSeries(
  seed: RecordSeed | null,
  live: RecordLive | null,
): PeakRecordSeries {
  const liveRecords = live?.traded_record_peaks;
  return {
    close: mergeRecordCandidates(seed?.traded_record_peaks, liveRecords),
    max: mergeRecordCandidates(seed?.traded_record_max_peaks, liveRecords),
  };
}
