/**
 * `/study` 캘린더 봉(D/W/M)의 **맥락 창**과 저장 구간 표시 좌표.
 *
 * 복기뷰가 캘린더 봉으로 전환됐을 때 저장 구간만 그리면 일봉의 존재 이유가 없다 —
 * 10분봉 7주 저장뷰를 일봉으로 바꾸면 캔들 35개가 화면을 채우고 "이 구간이 큰 그림
 * 어디였나" 를 답할 수 없다. 그래서 저장 구간 **앞뒤로** 창을 넓히고, 저장 구간은
 * 밴드로 표시한다(`StudySavedRangeBand`).
 *
 * 넓히는 건 `screenerDaily`(디스크 일봉) **한 쪽뿐**이다. 1분봉(hogaplay) 창의
 * `initialHistoricalDaysFor` 캡은 의도된 방어이고, 캡 밖은 스크리너 일봉이 덮는다는
 * 계약이 `studyReferenceQueryInputs` 에 이미 있다.
 *
 * 이후 구간(저장 시점엔 몰랐던 미래)을 **항상 보여준다** — 2026-08-09 사용자 결정.
 * 복기의 목적이 결과 확인이라 스포일러 회피보다 맥락이 우선이라는 판단이다.
 */
import { realMsToYyyymmdd, todayKstYyyymmdd } from '../live/liveDateTime';
import { isMinuteTimeframe } from '../state/livePage';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle } from '../api/types';

export type StudyDailyContextWindow = { from: string; to: string } | null;

/**
 * 캘린더 봉 조회 창의 from 센티널 — "전체 히스토리".
 *
 * 백엔드 `screener-daily-candles` 는 from 하한도 개수 상한도 없고(디스크 parquet
 * 스캔), corpus 는 1999-01-04 부터다 — 데이터 시작보다 확실히 이른 고정값이면 된다.
 * 상수라 쿼리 키가 저장 구간과 무관해져, 같은 종목이면 D/W/M 창·다른 저장뷰·탭
 * 워밍이 캐시 한 벌을 공유한다. payload 캡이 필요해지면 이 상수만 조이면 된다.
 */
export const STUDY_DAILY_FULL_HISTORY_FROM = '19900101';

/**
 * 캘린더 봉으로 볼 때의 조회·클립 창. **분봉이면 null** — 분봉 경로는 저장 구간이
 * 곧 화면이므로 창을 넓힐 이유도, 넓혀서 생기는 추가 fetch 를 감수할 이유도 없다.
 *
 * 앞: 전체 히스토리. 전에는 `/live` 초기 창과 같은 250봉이었는데, 그 왼쪽이
 * **영구 벽**이었다 — 좌측 팬의 backfill extend 신호는 발화해도 `/study` 에는
 * `historicalFromDate` 를 읽는 쿼리가 없어(그 소비자는 `/live` 전용 `useLiveBundle`)
 * fetch 가 0회다. 점진 백필 이식 대신 창을 여는 이유: 이 쿼리는 [from, 오늘] 창
 * 전체를 재조회하는 구조라(분봉과 달리 병합 캐시 없음) 딥 팬을 스텝으로 자르면
 * 누적 전송이 전체 1회 로드보다 오히려 커지고, settle 신호 배선(#1328류)까지
 * 붙는다. 전체도 싸다 — 실측 3,140캔들 = 320KB/19ms, 최악(1999년부터) 6,810캔들
 * = 695KB/34ms.
 * 뒤: 오늘. 디스크 일봉이라 넓혀도 벤더 호출이 늘지 않는다.
 */
export function studyDailyContextWindow(save: StudyViewReference | null): StudyDailyContextWindow {
  if (!save || isMinuteTimeframe(save.timeframe)) return null;
  return {
    from: STUDY_DAILY_FULL_HISTORY_FROM,
    to: todayKstYyyymmdd(),
  };
}

/**
 * 일봉 몸통이 읽히는 최대 가시 span.
 *
 * `LiveChartRoot` 의 `DAILY_MIN_EFFECTIVE_BAR_SPACING = 3.5`(#141 이 정한 하한)를
 * `/study` 차트 창의 실측 플롯 폭 ~562px 로 나눈 값이다. **px 에서 유도한 상수라
 * 밀도·레이아웃이 바뀌면 여기가 같이 틀어진다** — 상한이지 목표치가 아니고,
 * 넘기면 캔들이 몸통 없는 실선으로 붕괴한다.
 */
export const MAX_LEGIBLE_DAILY_SPAN = 160;

/** 저장 구간 우측으로 더 보여줄 비율. 0이면 받아온 이후 구간이 전부 화면 밖이라
 *  "이후를 보여준다" 는 결정이 화면에 드러나지 않는다. */
const AFTER_RANGE_RATIO = 0.35;

/** 저장 구간이 화면에서 차지할 비율의 역수 — 2.2 면 저장 구간이 우측 ~45%. */
const CONTEXT_SPAN_RATIO = 2.2;

export type StudyDailyViewport = {
  rightEdgeMs: number;
  barSpan: number;
  atLiveEdge: boolean;
};

/**
 * 캘린더 봉 초기 뷰포트. 저장 구간의 마지막 캔들에서 이후 구간 쪽으로 조금 민 지점을
 * 우측 앵커로 잡고, span 은 저장 구간의 `CONTEXT_SPAN_RATIO` 배(가독 상한 클램프).
 *
 * `atLiveEdge: false` 가 핵심이다 — true 면 `computeRestoreRange` 가 최신 봉을
 * 따라가 저장 구간이 화면 밖으로 밀린다.
 */
export function studyDailyViewport(
  candles: readonly Candle[],
  savedFromMs: number,
  savedToMs: number,
): StudyDailyViewport | null {
  if (candles.length === 0) return null;
  const inRange = candles.filter((c) => c.ts_ms >= savedFromMs && c.ts_ms <= savedToMs);
  const lastInRange = inRange[inRange.length - 1] ?? candles[candles.length - 1];
  if (!lastInRange) return null;
  const savedBars = Math.max(1, inRange.length);
  const endIdx = candles.findIndex((c) => c.ts_ms === lastInRange.ts_ms);
  const anchor = endIdx >= 0
    ? candles[Math.min(candles.length - 1, endIdx + Math.round(savedBars * AFTER_RANGE_RATIO))]
    : lastInRange;
  return {
    rightEdgeMs: anchor.ts_ms,
    barSpan: Math.max(1, Math.min(MAX_LEGIBLE_DAILY_SPAN, Math.round(savedBars * CONTEXT_SPAN_RATIO))),
    atLiveEdge: false,
  };
}

/**
 * 밴드가 쓰는 저장 구간 기술자. 경계는 **저장 구간 안에 실제로 존재하는 캔들의 ts**
 * 로만 잡는다 — D/W/M 의 timeScale 은 하루/한 주/한 달이 1포인트인 캘린더 축이라,
 * 축에 없는 임의 ms 를 좌표로 바꾸면 어긋난다(#1238 이 그 사고였다).
 */
export type StudySavedRangeMarks = {
  fromMs: number;
  toMs: number;
  barCount: number;
};

export function studySavedRangeMarks(
  save: StudyViewReference,
  candles: readonly Candle[],
): StudySavedRangeMarks | null {
  const inRange = candles.filter(
    (c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms,
  );
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  if (!first || !last) return null;
  return {
    fromMs: first.ts_ms,
    toMs: last.ts_ms,
    barCount: inRange.length,
  };
}

/**
 * `20250422` → `2025.04.22`.
 *
 * `/live` 의 `monthDay`(`MM/DD`)를 쓰지 않는 이유: 이 안내의 본체가 **저장 구간과
 * 코퍼스 시작이 다른 해인 경우**다(실측 010140 — 저장 2024-08, 코퍼스 2025-04).
 * 연도를 빼면 두 날짜가 같은 해처럼 읽혀 안내가 원인을 숨긴다.
 */
function dotted(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}.${yyyymmdd.slice(4, 6)}.${yyyymmdd.slice(6, 8)}`;
}

export type StudySavedRangeCoverageNotice = {
  /** 차트 위 칩 한 줄. */
  text: string;
  /** 툴팁·스크린리더용 뒷문장 — **결과**를 말한다(무엇이 안 보이는지, 어디부터 있는지). */
  detail: string;
};

/**
 * 저장 구간이 캘린더 봉 코퍼스에 실제로 있는지. 안내가 필요 없으면 `null`.
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────
 * 일봉 소스가 **두 개고 커버리지가 다르다.** `/live` D/W/M 은
 * `/api/live/past-daily-candles`(벤더 워크백, ADR-0048)이고 `/study` 는
 * `/api/live/screener-daily-candles`(디스크 `screener/daily_adjusted.parquet`)다.
 * 코퍼스 시작은 **종목마다 다르다** — 실측 2026-08-20: `005930` 1999-01-04(6,812봉),
 * `000660` 2015-01-02, **`010140` 2025-04-22(323봉)**.
 *
 * 그래서 `/live` 일봉 위에서 잡은 구간이 `/study` 에는 통째로 없을 수 있고, 그때
 * **아무 증상 없이** 두 기능이 사라진다: `studySavedRangeMarks` 가 null 을 내
 * 기간 밴드가 미마운트되고(뷰포트도 저장 구간에 못 앉는다), `resolveSyncTarget` 의
 * 날짜 조회가 빗나가 크로스헤어 동기화가 죽는다. 부분 커버리지는 더 나쁘다 —
 * 밴드가 그려지되 왼쪽 끝이 코퍼스 시작으로 **조용히 스냅해 구간을 거짓말한다**.
 *
 * ── 이 함수가 못 보는 것 ──────────────────────────────────────────────────
 * **경계만 본다.** 코퍼스 시작이 저장 시작보다 늦은가 / 코퍼스 끝이 저장 끝보다
 * 이른가 두 가지다. 구간 **안쪽의 구멍**(중간 며칠이 빠진 경우)은 판정하지 않는다 —
 * 일봉 표는 그런 구멍을 갖지 않는다는 전제이고, 갖는다면 그건 별개 문제다.
 * 다만 "저장 구간 안에 봉이 하나도 없다" 는 경계가 아니라 **직접** 센다. 그게
 * 밴드·동기화를 죽이는 정확한 술어이기 때문이다.
 *
 * 휴장일 오탐은 없다. 판정 기준이 저장 시작 그 날의 봉 유무가 아니라 **코퍼스의
 * 첫/끝 봉**이라, 저장 시작이 토요일이어도 코퍼스가 그 전부터 있으면 통과한다.
 *
 * W/M 에서도 정확하다 — `aggregateCalendar` 가 버킷 ts 를 캘린더 주기 시작이 아니라
 * **그 버킷의 첫 봉 시각**으로 잡아서, 집계 후에도 `candles[0].ts_ms` 가 일봉 코퍼스의
 * 진짜 시작일과 같다.
 *
 * ── 호출부 의존 ───────────────────────────────────────────────────────────
 * **맥락 창(`dailyContext`)이 열린 캘린더 봉에서만 부른다.** 분봉 경로의 캔들은 저장
 * 구간으로 클립돼 있어(`buildStudyReferenceBundleModel`) `candles[0]` 이 항상 구간
 * 안이고, 그러면 이 판정이 전 구간을 "앞이 잘렸다" 로 오독한다. 밴드와 **같은
 * 게이트**를 쓴다.
 */
export function studySavedRangeCoverage(
  save: StudyViewReference,
  candles: readonly Candle[],
  /** 이 창의 봉 — 동기화 문구는 `D` 에서만 참이다(`CursorSyncCrosshair` 가 `D` 전용). */
  timeframe: StudyViewReference['timeframe'],
): StudySavedRangeCoverageNotice | null {
  const first = candles[0];
  const last = candles[candles.length - 1];
  // 캔들이 아예 없으면 차트가 통째로 비어 있다 — 그 화면은 빈 상태가 소유한다.
  // 여기서 한마디 더 얹으면 같은 사실을 두 곳에서 다르게 말하게 된다.
  if (!first || !last) return null;

  // 표시 날짜도 **비교에 쓴 ms 에서** 뽑는다. `save.range.from_date` 를 쓰면 문구와
  // 판정이 서로 다른 필드를 근거로 삼아, 둘이 어긋나는 날 안내가 조용히 거짓이 된다.
  const savedFrom = dotted(realMsToYyyymmdd(save.range.from_ms));
  const savedTo = dotted(realMsToYyyymmdd(save.range.to_ms));
  const corpusFrom = dotted(realMsToYyyymmdd(first.ts_ms));
  const corpusTo = dotted(realMsToYyyymmdd(last.ts_ms));

  const hasAnyInRange = candles.some(
    (c) => c.ts_ms >= save.range.from_ms && c.ts_ms <= save.range.to_ms,
  );
  if (!hasAnyInRange) {
    // 동기화까지 죽는 건 `D` 뿐이다 — W/M 에는 애초에 동기화가 없어 그걸 잃었다고
    // 말하면 없는 기능을 잃은 것처럼 들린다.
    const lost = timeframe === 'D'
      ? '기간 밴드와 크로스헤어 동기화가 표시되지 않습니다'
      : '기간 밴드가 표시되지 않습니다';
    return {
      text: '저장 구간 데이터 없음',
      detail: `저장 구간 ${savedFrom}~${savedTo} 에 해당하는 봉이 없어 ${lost}. 이 종목의 과거 데이터는 ${corpusFrom}~${corpusTo} 만 있습니다.`,
    };
  }

  const missingBefore = first.ts_ms > save.range.from_ms;
  const missingAfter = last.ts_ms < save.range.to_ms;
  if (!missingBefore && !missingAfter) return null;

  const held = missingBefore && missingAfter
    ? `${corpusFrom}~${corpusTo} 만`
    : missingBefore
      ? `${corpusFrom} 부터`
      : `${corpusTo} 까지만`;
  return {
    text: '저장 구간 일부만 표시',
    detail: `저장 구간은 ${savedFrom}~${savedTo} 인데 이 종목의 과거 데이터는 ${held} 있습니다. 기간 밴드가 그 경계에서 잘립니다.`,
  };
}
