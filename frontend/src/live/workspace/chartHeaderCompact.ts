/**
 * 차트 창 헤더의 접힘 판정 (#762 접힘 정책).
 *
 * 창이 좁아지면 액션 버튼(그리기·보조지표)의 텍스트 라벨을 접고 아이콘만
 * 남긴다. #762 실측: 라벨을 단 헤더는 ~326px 를 쓰고, 그보다 좁아지면
 * `+보조지표` 가 `overflow-hidden` 에 **예고 없이 잘려 사라졌다**(250px 에서
 * 41px 스필). 버튼이 2개뿐이어도 임계는 실재한다.
 *
 * **관측 대상은 헤더 컨테이너 폭이어야 한다.** 내용물 폭(scrollWidth)을 재면
 * `좁음 → 라벨 접기 → 내용물 넓어짐 → 펴기 → 다시 좁음` 으로 진동한다.
 * 컨테이너 폭은 창 크기가 정하므로 접힘이 그것을 되바꾸지 않는다 —
 * `usePaneFolding` 이 컨테이너 *높이* 를 재는 것과 같은 이유다.
 *
 * 순수 판정은 아래 함수로 분리해 테스트가 ResizeObserver 없이 임계·히스테리시스를
 * 직접 검증할 수 있게 한다(훅은 관측만 담당).
 */

/**
 * 아이콘만 남은 액션 버튼의 좌우 여백(px). 기본 `px-2`(8px)는 라벨과 아이콘을
 * 떼어놓기 위한 값이라 라벨이 없으면 순수 낭비다 — 좁히지 않으면 4버튼 완전
 * 접힘이 `MIN_W`(160px)에 들어가지 않는다(실측: 여백 유지 시 181px 필요).
 * 인라인 style 로 적용해야 컴포넌트가 클래스로 들고 있는 `px-2` 를 이긴다.
 */
export const COMPACT_PADDING_INLINE = '4px';

/** 라벨을 유지할 수 있는 헤더 최소 폭(px).
 *
 *  실측(액션 4버튼): 봉 그룹 150 + 라벨 액션 251 + 패딩·갭 14 = **415px**.
 *  긴 분봉 라벨("30분")과 테마별 폰트 편차 여유를 얹었다.
 *  ⚠️ 헤더에 버튼을 더하거나 라벨을 바꾸면 이 값은 **반드시 다시 실측**해야 한다 —
 *  2버튼 시절 값(344)을 그대로 두었다가 71px 부족으로 무성 잘림이 났다. */
export const HEADER_LABEL_MIN_WIDTH_PX = 424;

/** 되펴기 임계 — 접힘/펴짐 경계에서 1px 떨림에 깜빡이지 않도록 dead band 를 둔다.
 *  `usePaneFolding` 의 히스테리시스와 같은 취지. */
export const HEADER_LABEL_RESTORE_WIDTH_PX = HEADER_LABEL_MIN_WIDTH_PX + 24;

/**
 * 봉 컨트롤(일·주·월 버튼)까지 접어야 하는 폭. 라벨을 접어도 헤더는 **213px**
 * 를 요구하는데(실측) 창은 `MIN_W = 160px` 까지 좁아진다 — 그 사이에서 액션
 * 버튼이 다시 조용히 잘렸다. 2단계에서는 일·주·월을 분봉 드롭다운 안으로
 * 합쳐(#762 B 변형이 검증한 모양) 필요 폭을 ~110px 로 낮춘다.
 */
export const HEADER_TIMEFRAME_FOLD_WIDTH_PX = 258;
export const HEADER_TIMEFRAME_RESTORE_WIDTH_PX = HEADER_TIMEFRAME_FOLD_WIDTH_PX + 24;

export type HeaderFold = {
  /** 액션 버튼의 텍스트 라벨을 접는다(아이콘만). */
  compactActions: boolean;
  /** 일·주·월을 분봉 드롭다운 안으로 합친다. */
  compactTimeframe: boolean;
};

export const HEADER_FOLD_NONE: HeaderFold = { compactActions: false, compactTimeframe: false };

/**
 * 한 헤더 표면의 접힘 임계 묶음.
 *
 * **정책은 공유하고 숫자는 표면마다 잰다.** 임계는 그 헤더가 실제로 들고 있는
 * 버튼 수·라벨 길이의 함수라, 액션 4개인 `/live` 값을 액션 2개인 `/study` 에
 * 그대로 쓰면 ~120px 일찍 접힌다. 반대 방향 사고의 전례가 #767 이다 — 2버튼
 * 시절 값(344)을 4버튼 헤더에 방치해 71px 부족으로 `+보조지표` 가 무성 잘렸다.
 */
export type HeaderFoldThresholds = {
  labelMinWidthPx: number;
  labelRestoreWidthPx: number;
  timeframeFoldWidthPx: number;
  timeframeRestoreWidthPx: number;
};

/** `/live` 차트 창 헤더 — 액션 4버튼(그리기·보조지표·저장뷰·수집) 실측. */
export const LIVE_HEADER_FOLD: HeaderFoldThresholds = {
  labelMinWidthPx: HEADER_LABEL_MIN_WIDTH_PX,
  labelRestoreWidthPx: HEADER_LABEL_RESTORE_WIDTH_PX,
  timeframeFoldWidthPx: HEADER_TIMEFRAME_FOLD_WIDTH_PX,
  timeframeRestoreWidthPx: HEADER_TIMEFRAME_RESTORE_WIDTH_PX,
};

/**
 * `/study` 차트 창 헤더가 각 접힘 단계에서 **실제로 요구하는 폭**(content-box, px).
 *
 * 실측 방법(#905, 2026-07-29): `/browse` 로 실제 저장뷰를 열고 헤더를 자유 폭
 * 컨테이너에 복제해 `max-content` 폭을 잰 뒤 컨테이너 패딩을 뺐다. 창 폭을
 * 0.72 → 0.13(=`MIN_W`)까지 좁혀 가며 단계별로 반복.
 *
 * 불변 확인: **두 테마(obsidian·ledger) 동일**(DESIGN.md 의 "테마는 색만" 과 일치),
 * **최장 분봉 라벨(30분)에서도 동일**(봉 라벨이 `tnum` 이라 자릿수 폭이 같다).
 *
 * ⚠️ 관측값은 `ResizeObserver` 의 `contentRect.width`(**content-box**)라 컨테이너
 * 좌우 패딩(기본 밀도에서 9px)을 이미 뺀 값이다 — `clientWidth` 로 비교하면 어긋난다.
 */
export const STUDY_HEADER_NEED = {
  /** 다 펴진 상태: 봉 그룹 + 라벨 단 액션 2개. */
  full: 303,
  /** 1단계: 액션 라벨만 접음(아이콘 2개) + 봉 그룹 유지. */
  actionsFolded: 202,
  /** 2단계: 봉 드롭다운 + 아이콘 2개. 이보다 좁아지면 더 접을 게 없다. */
  bothFolded: 104,
} as const;

/** 되펴기 dead band 와 별개인 접힘 여유 — 폰트 렌더 편차·소수 픽셀 반올림 몫. */
const STUDY_FOLD_MARGIN_PX = 16;

/**
 * `/study` 차트 창 헤더 — 액션 **2버튼**(그리기·보조지표). 저장뷰 저장·수집은
 * `/study` 에 없다(지도 #900 Out of scope).
 *
 * 임계를 실측값에서 **파생**시킨다. 재측정하면 위 숫자 하나만 고치면 되고,
 * "임계가 그 단계의 요구 폭보다 큰가" 를 테스트가 기계적으로 검사할 수 있다.
 *
 * `/live` 값을 그대로 쓰면 **양방향으로 틀린다**:
 * - 1단계 424 는 너무 커서 라벨이 121px 일찍 사라지고,
 * - 2단계 258 은 너무 커서 일·주·월이 **56px 일찍** 사라진다(1단계 형태는 202 면 된다).
 *
 * 어림도 못 미덥다 — "액션 2개는 4개의 절반" 으로 잡은 잠정값 300 은 실측 303 보다
 * **3px 모자랐다**. 그대로 뒀으면 경계 폭에서 `보조지표` 가 무성 잘리는 #767 의
 * 재현이다. 반대 방향 전례도 같은 파일이 경고하고 있었다.
 */
export const STUDY_HEADER_FOLD: HeaderFoldThresholds = {
  labelMinWidthPx: STUDY_HEADER_NEED.full + STUDY_FOLD_MARGIN_PX,
  labelRestoreWidthPx: STUDY_HEADER_NEED.full + STUDY_FOLD_MARGIN_PX + 24,
  timeframeFoldWidthPx: STUDY_HEADER_NEED.actionsFolded + STUDY_FOLD_MARGIN_PX,
  timeframeRestoreWidthPx: STUDY_HEADER_NEED.actionsFolded + STUDY_FOLD_MARGIN_PX + 24,
};

/**
 * 폭과 직전 상태로 다음 접힘 단계를 정한다. 각 단계는 자기 dead band 안에서
 * 직전 상태를 유지하므로 같은 입력·같은 직전 상태에 대해 멱등이다
 * (StrictMode 이중 렌더 안전).
 *
 * 폭 0 은 "아직 측정 전"(마운트 직후·display:none)이라 접지 않는다 — 첫 프레임에
 * 라벨이 깜빡 사라졌다 나타나는 것을 막는다.
 */
export function nextHeaderFold(
  widthPx: number,
  prev: HeaderFold,
  thresholds: HeaderFoldThresholds = LIVE_HEADER_FOLD,
): HeaderFold {
  if (widthPx <= 0) return prev;
  return {
    compactActions: prev.compactActions
      ? widthPx < thresholds.labelRestoreWidthPx
      : widthPx < thresholds.labelMinWidthPx,
    compactTimeframe: prev.compactTimeframe
      ? widthPx < thresholds.timeframeRestoreWidthPx
      : widthPx < thresholds.timeframeFoldWidthPx,
  };
}
