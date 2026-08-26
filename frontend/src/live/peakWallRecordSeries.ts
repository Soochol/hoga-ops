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
  session: readonly AskPeakCandidate[] = [],
): PeakRecordSeries {
  const liveRecords = live?.traded_record_peaks;
  return {
    close: mergeRecordCandidates(seed?.traded_record_peaks, liveRecords, session),
    max: mergeRecordCandidates(seed?.traded_record_max_peaks, liveRecords, session),
  };
}

// ── 접속 이후 기록 누적 ──────────────────────────────────────────────────────
//
// 위 두 출처는 **접속 이후 변화를 느리게 본다**: `/api/live/series` 는 마운트 1회
// 조회이고(`liveSeries.ts` — focus refetch 전역 off, interval 없음, WS 는 peak 을 밀지
// 않는다), `/api/range` 는 5분 폴링 + 프로모션 5분이라 최악 ~10분 늦는다. 그 창 안에서
// 기록을 세우고 **동시에** top-3 밖으로 밀린 벽은 잠시 사라졌다가 돌아온다.
//
// 이 누적기가 그 창을 닫는다. 세션 동안 화면에 실린 top-3 을 전부 제시해 두면,
// **기록을 세운 벽은 그 순간 반드시 1위였으므로** 반드시 여기에 담긴다. 순위 밖으로
// 밀려도 누적기에 남아 계단이 그 계단을 잃지 않는다.

/** 기록 시퀀스 상한. 백엔드 `_TRADED_RECORD_CAP`·과거일 `_PEAK_RECORD_CAP` 미러 —
 *  자르는 쪽도 같다(뒤). 실제로는 prefix maxima 접기가 훨씬 먼저 억제한다. */
export const PEAK_RECORD_CAP = 128;

/**
 * 기록 시퀀스(시간순 prefix maxima)에 벽 하나를 제시한다 — **제시 순서에 무관**하고 멱등.
 * 백엔드 `_TodaySidePeakState._offer_record` 의 미러이고 규약이 같다:
 *
 * - 리스트 불변식은 (t_ms 오름차순, qty 순증가). qty 가 순증가이므로 "그 시각까지의
 *   최대" 가 **바로 앞 항목 하나**이고 판정이 O(1) 이다.
 * - 동률은 **먼저 도달한 것을 유지**한다(strict `>`) — 같은 벽을 두 번 제시해도
 *   두 번째가 동률로 거부되므로 멱등이다(누적기가 이에 기댄다).
 * - 뒤늦게 제시된 **앞선 시각**의 벽은 뒤 항목을 소급 무효화한다(순증가 복구).
 *
 * `records` 를 **제자리에서** 고친다 — 누적기가 렌더마다 부르는 자리라 배열을 새로
 * 만들면 참조가 매번 흔들린다.
 */
export function offerPeakRecord(records: AskPeakCandidate[], peak: AskPeakCandidate): boolean {
  if (!Number.isFinite(peak.qty) || !Number.isFinite(peak.t_ms)) return false;
  let i = records.length;
  while (i > 0 && records[i - 1].t_ms > peak.t_ms) i -= 1;
  if (i > 0 && records[i - 1].qty >= peak.qty) return false;
  let j = i;
  while (j < records.length && records[j].qty <= peak.qty) j += 1;
  records.splice(i, j - i, peak);
  if (records.length > PEAK_RECORD_CAP) records.length = PEAK_RECORD_CAP;
  return true;
}

/**
 * 접속 이후 화면에 실린 top-3 을 접어 두는 누적기 — 훅 수명 동안 살아 있다
 * (`IncrementalPeakWallSource` 와 같은 `useRef` 수명).
 *
 * ⚠ **`deriveDay*PeaksIncremental` 안이 아니라 훅에서 쓴다.** 그 derive 는 배치판과
 * 값이 같아야 하고(`incrementalPeakWallSource.test.ts` 가 전체 행을 `toEqual` 로 잰다),
 * 배치는 버퍼 창만 보므로 축출된 기록을 원리적으로 못 가진다. 누적을 derive 안에 두면
 * 그 동등성이 조용히 깨진다 — 보존은 **derive 위 층**의 일이다.
 *
 * 축출이 지운 것을 되살리는 것이 과잉 주장은 아니다: ADR-0156 의 터치 판정은 그 벽의
 * 1분 안에서 닫히므로 **사실 자체는 변하지 않는다**. 창에서 사라지는 것은 근거를 다시
 * 볼 능력일 뿐이고, 백엔드는 그 사실을 하루 내내 들고 있다(`traded_record`).
 */
export class PeakRecordAccumulator {
  private key = '';
  private records: AskPeakCandidate[] = [];

  /**
   * 이번 갱신의 top-3 을 제시하고 누적된 기록을 돌려준다.
   *
   * `scopeKey` 는 (종목, 날짜, 세션개장) — 하나라도 바뀌면 누적을 버린다. 훅이 이
   * 인스턴스를 `useRef` 로 붙들어 종목 전환을 인스턴스 교체로 표현할 수 없기 때문이고,
   * `IncrementalPeakWallSource` 가 `sessionOpenMs` 에 대해 쓰는 것과 같은 장치다.
   */
  update(scopeKey: string, candidates: readonly AskPeakCandidate[]): readonly AskPeakCandidate[] {
    if (scopeKey !== this.key) {
      this.key = scopeKey;
      this.records = [];
    }
    for (const candidate of candidates) offerPeakRecord(this.records, candidate);
    return this.records;
  }
}

/**
 * 오늘 행의 기록 시퀀스에 **접속 이후 누적분**을 얹는다.
 *
 * 누적기에 제시하는 것은 오늘 행의 `traded_peaks`(그 순간의 top-3)다 — 기록을 세운 벽은
 * 그 순간 반드시 1위이므로 여기에 반드시 들어온다. 순위 밖의 2·3위도 같이 제시되지만
 * `offerPeakRecord` 가 기록이 아닌 것을 떨궈 리스트가 커지지 않는다.
 *
 * 오늘 행이 없으면 행은 그대로 두되 **누적기의 스코프 갱신은 한다** — 그래야 종목을
 * 바꾼 직후 오늘 행이 아직 없는 프레임에서 옛 종목의 기록이 살아남지 않는다.
 */
export function withSessionRecords<T extends {
  date: string;
  traded_peaks?: AskPeakCandidate[];
  traded_record_peaks?: AskPeakCandidate[];
  traded_record_max_peaks?: AskPeakCandidate[];
}>(
  rows: T[],
  accumulator: PeakRecordAccumulator,
  todayKst: string,
  scopeKey: string,
): T[] {
  const index = rows.findIndex((row) => row.date === todayKst);
  const today = index >= 0 ? rows[index] : null;
  const session = accumulator.update(scopeKey, today?.traded_peaks ?? []);
  // 참조 안정성: 얹을 것이 없으면 원 배열을 그대로 돌려준다(소비처 memo 가 흔들리지 않게).
  if (today === null || session.length === 0) return rows;
  const out = rows.slice();
  out[index] = {
    ...today,
    traded_record_peaks: mergeRecordCandidates(today.traded_record_peaks, session),
    traded_record_max_peaks: mergeRecordCandidates(today.traded_record_max_peaks, session),
  };
  return out;
}
