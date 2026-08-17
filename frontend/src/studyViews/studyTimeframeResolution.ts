/** `/study` 가 "지금 어떤 봉인가" 에 답하는 자리.
 *
 * **봉의 소유자는 차트 창이다**(#1326). 창이 여러 개면 포커스된 창이 탭과 거울을 이룬다
 * (#801). 그 결정 자체는 확정 사항이고 이 파일이 바꾸지 않는다 — 여기 모은 것은 **그
 * 결정을 적용하는 폴백 사슬**이다.
 *
 * ## 왜 모았나
 *
 * 같은 질문에 답하는 사슬이 `StudyPage` 본문에 인라인 표현식으로 흩어져 있었고, **끝값이
 * 서로 달랐다**. 한 표현식 안에서 갈리기까지 했다 — 헤더 분봉 슬롯이 "뷰가 있으면 `'1m'`,
 * 없으면 `'3m'`" 이었는데 그 차이를 정당화하는 근거가 없었다.
 *
 * 그 차이는 **지표 스코프에서만 무증상**이다(프로필이 `minute|D|W|M` 네 버킷으로 접히므로
 * `1m`↔`3m` 이 같은 값이 된다 — `profileKeyForTimeframe`). 나머지는 전부 갈린다:
 * 쿼리 키의 `bucket_ms` · range 캐시 축출 축 · 탭 라벨 · 뷰포트 보존 술어 · 차트 렌더.
 *
 * ## 왜 순수 함수인가
 *
 * 인라인 표현식이라 **이 결정을 단독으로 재는 테스트가 하나도 없었다** — 14~17건이
 * `StudyPage` 전체 렌더 + mock props 확인에 얹혀 있었다. 폴백 하나를 확인하려면 페이지
 * 픽스처를 통과해야 했고, 그래서 끝값이 갈린 것도 오래 보이지 않았다.
 */
import { isMinuteTimeframe, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';
import { STUDY_DEFAULT_MINUTE_TIMEFRAME } from '../state/studyLastMinuteTimeframe';

/** 탭이 들고 있는 것 중 봉 결정에 쓰이는 부분만. */
export type StudyTimeframeTab = {
  readonly viewId: string;
  readonly timeframe: LiveTimeframe;
};

export type SelectedTimeframeInput = {
  /** 포커스된 차트 창의 봉. **유일한 소유자**라 사슬의 맨 앞이다. */
  readonly chartWindowTimeframe: LiveTimeframe | null;
  readonly activeViewId: string | null;
  readonly activeTab: StudyTimeframeTab | null;
  /** 뷰별 로컬 기억(창·탭이 아직 없는 과도기용). */
  readonly viewTimeframes: Readonly<Record<string, LiveTimeframe>>;
  /** 저장뷰가 저장된 봉. 사슬의 **맨 끝**이다. */
  readonly savedTimeframe: LiveTimeframe | null;
};

/** 지금 화면이 서 있는 봉. 뷰가 없으면 `null`.
 *
 * 뒤의 폴백은 창이 아직 없거나(하이드레이션 전) 탭 없는 라우트로 들어온 과도기에만 닿는다.
 * **저장뷰의 봉은 맨 끝이라 열린 창이 하나라도 있으면 절대 이기지 못한다** — 그게 이
 * 페이지의 계약이다. */
export function resolveSelectedTimeframe(input: SelectedTimeframeInput): LiveTimeframe | null {
  const { chartWindowTimeframe, activeViewId, activeTab, viewTimeframes, savedTimeframe } = input;
  if (!activeViewId || savedTimeframe === null) return null;
  return (
    chartWindowTimeframe
    ?? (activeTab?.viewId === activeViewId ? activeTab.timeframe : undefined)
    ?? viewTimeframes[activeViewId]
    ?? savedTimeframe
  );
}

export type RememberedMinuteInput = {
  /** 포커스 창이 기억하는 분봉. */
  readonly chartWindowLastMinute: MinuteTimeframe | null;
  readonly activeViewId: string | null;
  readonly rememberedMinuteTimeframes: Readonly<Record<string, MinuteTimeframe>>;
  readonly savedTimeframe: LiveTimeframe | null;
};

/** 헤더 컨트롤의 분봉 슬롯이 보여줄 봉(#902).
 *
 * ⚠ 종전엔 끝값이 **뷰의 유무로 갈렸다** — 뷰가 있으면 `'1m'`, 없으면 `'3m'`. 두 자리 다
 * "아무 단서가 없을 때 무엇을 보여주나" 라는 같은 질문이라 갈릴 이유가 없었고, 갈린 근거도
 * 어디에도 없었다. 이름이 붙은 정책 상수 쪽으로 통일한다. */
export function resolveRememberedMinuteTimeframe(input: RememberedMinuteInput): MinuteTimeframe {
  const { chartWindowLastMinute, activeViewId, rememberedMinuteTimeframes, savedTimeframe } = input;
  if (chartWindowLastMinute) return chartWindowLastMinute;
  if (!activeViewId || savedTimeframe === null) return STUDY_DEFAULT_MINUTE_TIMEFRAME;
  return (
    rememberedMinuteTimeframes[activeViewId]
    ?? (isMinuteTimeframe(savedTimeframe) ? savedTimeframe : STUDY_DEFAULT_MINUTE_TIMEFRAME)
  );
}

export type IndicatorPanelTimeframeInput = {
  /** 활성 뷰가 ready 면 그 저장 봉, 아니면 `null`. */
  readonly readySavedTimeframe: LiveTimeframe | null;
  readonly selectedTimeframe: LiveTimeframe | null;
  readonly activeTab: StudyTimeframeTab | null;
};

/** 지표 패널·ambient 지표 버킷이 쓸 봉.
 *
 * 로딩·에러 구간의 폴백도 **창을 먼저 읽는다**(#1326) — 봉의 소유자가 창이므로 탭을 먼저
 * 읽으면 아직 되받아쓰기 전인 저장 봉이 지표 버킷으로 새어 나간다.
 *
 * 이 자리의 끝값은 지표 프로필이 4버킷으로 접혀 **결과가 같지만**, 같은 질문의 끝값이
 * 자리마다 다르면 다음 사람이 어느 쪽이 정책인지 알 수 없다. 통일한다. */
export function resolveIndicatorPanelTimeframe(input: IndicatorPanelTimeframeInput): LiveTimeframe {
  const { readySavedTimeframe, selectedTimeframe, activeTab } = input;
  if (readySavedTimeframe !== null) return readySavedTimeframe;
  return selectedTimeframe ?? activeTab?.timeframe ?? STUDY_DEFAULT_MINUTE_TIMEFRAME;
}
