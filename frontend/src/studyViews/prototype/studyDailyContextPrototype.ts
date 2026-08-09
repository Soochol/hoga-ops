/**
 * ⚠ PROTOTYPE — throwaway. 이 폴더 전체가 `/prototype` 스킬 산출물이고 main 에
 * 남기지 않는다. 승자 변형만 정식 코드로 다시 쓰고 나머지는 브랜치에 봉인한다.
 *
 * 질문: **`/study` 에서 일봉을 고르면 무엇을 보여줘야 하는가?**
 *
 * 현재 상태는 저장 구간(`save.range`)으로 캔들을 잘라 버려서, 10분봉 7주짜리
 * 복기뷰를 일봉으로 바꾸면 캔들 35개가 화면을 가득 채운다 — "이 구간이 큰 그림에서
 * 어디였나" 라는 일봉의 존재 이유가 사라진다.
 *
 * 변형 축은 **레이아웃이 아니라 "저장 구간을 넓은 일봉 맥락 안에서 어떻게
 * 표시하는가"** 다. 데이터 확장(아래 창 계산)은 세 변형이 공유하는 배관이고,
 * 변형은 ① 구간 표기 방식 ② 초기 뷰포트 정책 ③ 하단 레일 유무에서 갈린다.
 *
 * `?variant=` 와 별개로 `?after=1` 은 **저장 구간 이후(미래) 일봉 노출**을 켠다 —
 * 복기 도구에서 "결과를 미리 보여줄 것인가" 는 변형과 독립된 결정이라 따로 뺐다.
 */
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from '../../live/liveDateTime';
import type { StudyViewReference } from '../../api/studyViews';
import type { Candle } from '../../api/types';

export const STUDY_DAILY_VARIANTS = ['off', 'A', 'B', 'C'] as const;
export type StudyDailyVariant = (typeof STUDY_DAILY_VARIANTS)[number];

export const STUDY_DAILY_VARIANT_LABELS: Record<StudyDailyVariant, string> = {
  off: '현재 — 저장 구간만 (기준선)',
  A: 'A — 밴드 + 경계선',
  B: 'B — 구간 밖 디밍(스포트라이트)',
  C: 'C — 확대 + 하단 미니맵 레일',
};

export const STUDY_DAILY_VARIANT_NOTES: Record<StudyDailyVariant, string> = {
  off: '지금 배포된 동작. 저장 구간 밖 일봉을 아예 받지 않는다.',
  A: '맥락과 저장 구간이 같은 밝기. 구간은 accent 밴드 + 양끝 실선으로 표시.',
  B: '저장 구간만 밝고 나머지는 덮개로 어둡다. 뷰포트는 맥락 전체를 잡는다.',
  C: '차트는 저장 구간 확대. 위치는 하단 미니맵이 말한다(클릭하면 그 지점으로 이동).',
};

const VARIANT_PARAM = 'variant';
const AFTER_PARAM = 'after';

export function parseStudyDailyVariant(raw: string | null): StudyDailyVariant {
  return (STUDY_DAILY_VARIANTS as readonly string[]).includes(raw ?? '')
    ? (raw as StudyDailyVariant)
    : 'off';
}

export function parseStudyDailyAfter(raw: string | null): boolean {
  return raw === '1';
}

export const STUDY_DAILY_PARAMS = { variant: VARIANT_PARAM, after: AFTER_PARAM } as const;

/** 저장 구간 앞에 붙일 맥락의 폭. `/live` 일봉 초기 창(250봉)과 같은 값을 쓴다 —
 * "라이브에서 보던 만큼" 이 사용자 기대치라 새 상수를 만들지 않는다. */
export function studyDailyContextWindow(
  save: StudyViewReference,
  showAfter: boolean,
): { from: string; to: string } {
  return {
    from: subtractDaysKst(save.range.from_date, initialHistoricalDaysFor('D')),
    to: showAfter ? todayKstYyyymmdd() : save.range.to_date,
  };
}

/** 일봉 몸통이 읽히는 최대 span. `/live` 의 `DAILY_MIN_EFFECTIVE_BAR_SPACING=3.5`
 * 를 폭 ~560px 기준으로 환산한 값이다(#141 회귀 방지 — 넓은 히스토리를 fit 하면
 * 몸통이 1~2px 로 붕괴한다). 프로토타입이라 실측 폭 대신 상수로 고정한다. */
export const MAX_LEGIBLE_DAILY_SPAN = 160;

export type StudyDailyViewport = {
  rightEdgeMs: number;
  barSpan: number;
  atLiveEdge: boolean;
};

/**
 * 변형별 초기 뷰포트. 저장 구간의 **마지막 캔들**에 우측 앵커를 걸고 span 만 바꾼다.
 * - A: 저장 구간이 우측 ~45% (좌측에 맥락이 같은 비중으로 붙는다)
 * - B: 맥락 전체 (읽히는 상한까지)
 * - C: 저장 구간 위주 확대 (맥락은 하단 레일이 담당)
 */
export function studyDailyViewport(
  variant: StudyDailyVariant,
  candles: readonly Candle[],
  savedFromMs: number,
  savedToMs: number,
  /** 이후 구간 노출 시 우측 앵커를 저장 끝에서 조금 더 민다 — 안 그러면 받아온
   *  미래 봉이 전부 화면 밖이라 토글이 아무것도 안 하는 것처럼 보인다. */
  showAfter = false,
): StudyDailyViewport | null {
  if (variant === 'off' || candles.length === 0) return null;
  const inRange = candles.filter((c) => c.ts_ms >= savedFromMs && c.ts_ms <= savedToMs);
  const lastInRange = inRange[inRange.length - 1] ?? candles[candles.length - 1];
  if (!lastInRange) return null;
  const savedBars = Math.max(1, inRange.length);
  const endIdx = candles.findIndex((c) => c.ts_ms === lastInRange.ts_ms);
  const anchor = showAfter && endIdx >= 0
    ? candles[Math.min(candles.length - 1, endIdx + Math.round(savedBars * 0.35))]
    : lastInRange;
  const barSpan =
    variant === 'A'
      ? Math.min(MAX_LEGIBLE_DAILY_SPAN, Math.round(savedBars * 2.2))
      : variant === 'B'
        ? Math.min(MAX_LEGIBLE_DAILY_SPAN, candles.length)
        : Math.min(MAX_LEGIBLE_DAILY_SPAN, Math.round(savedBars * (showAfter ? 1.5 : 1.15)));
  return { rightEdgeMs: anchor.ts_ms, barSpan: Math.max(1, barSpan), atLiveEdge: false };
}

/** 밴드/디밍/레일이 공유하는 저장 구간 기술자. 캔들 ts 로만 잡는다 —
 * 캘린더 축(D/W/M)에서는 하루가 1포인트라 임의 ms 를 좌표로 바꾸면 어긋난다. */
export type StudySavedRangeMarks = {
  fromMs: number;
  toMs: number;
  barCount: number;
  label: string;
};

export function studySavedRangeMarks(
  save: StudyViewReference,
  savedTimeframeLabel: string,
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
    label: `저장 구간 · ${formatDate(save.range.from_date)}–${formatDate(save.range.to_date)} · ${savedTimeframeLabel}`,
  };
}

/** 저장 봉의 사람용 라벨. `TimeframeControl` 의 `CALENDAR_LABELS` 는 export 가
 * 아니라 프로토타입 안에 최소판을 다시 둔다(승자 확정 시 그쪽을 쓰거나 export). */
export function timeframeLabel(tf: string): string {
  if (tf === 'D') return '일봉';
  if (tf === 'W') return '주봉';
  if (tf === 'M') return '월봉';
  return `${tf.replace('m', '')}분봉`;
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}
