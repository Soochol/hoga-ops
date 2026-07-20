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

/** 라벨을 유지할 수 있는 헤더 최소 폭(px). 실측 요구폭 ~326px(1분 기준)에
 *  긴 분봉 라벨("30분")과 테마별 폰트 편차 여유를 얹었다. */
export const HEADER_LABEL_MIN_WIDTH_PX = 344;

/** 되펴기 임계 — 접힘/펴짐 경계에서 1px 떨림에 깜빡이지 않도록 dead band 를 둔다.
 *  `usePaneFolding` 의 히스테리시스와 같은 취지. */
export const HEADER_LABEL_RESTORE_WIDTH_PX = HEADER_LABEL_MIN_WIDTH_PX + 24;

/**
 * 봉 컨트롤(일·주·월 버튼)까지 접어야 하는 폭. 라벨을 접어도 헤더는 **213px**
 * 를 요구하는데(실측) 창은 `MIN_W = 160px` 까지 좁아진다 — 그 사이에서 액션
 * 버튼이 다시 조용히 잘렸다. 2단계에서는 일·주·월을 분봉 드롭다운 안으로
 * 합쳐(#762 B 변형이 검증한 모양) 필요 폭을 ~110px 로 낮춘다.
 */
export const HEADER_TIMEFRAME_FOLD_WIDTH_PX = 232;
export const HEADER_TIMEFRAME_RESTORE_WIDTH_PX = HEADER_TIMEFRAME_FOLD_WIDTH_PX + 24;

export type HeaderFold = {
  /** 액션 버튼의 텍스트 라벨을 접는다(아이콘만). */
  compactActions: boolean;
  /** 일·주·월을 분봉 드롭다운 안으로 합친다. */
  compactTimeframe: boolean;
};

export const HEADER_FOLD_NONE: HeaderFold = { compactActions: false, compactTimeframe: false };

/**
 * 폭과 직전 상태로 다음 접힘 단계를 정한다. 각 단계는 자기 dead band 안에서
 * 직전 상태를 유지하므로 같은 입력·같은 직전 상태에 대해 멱등이다
 * (StrictMode 이중 렌더 안전).
 *
 * 폭 0 은 "아직 측정 전"(마운트 직후·display:none)이라 접지 않는다 — 첫 프레임에
 * 라벨이 깜빡 사라졌다 나타나는 것을 막는다.
 */
export function nextHeaderFold(widthPx: number, prev: HeaderFold): HeaderFold {
  if (widthPx <= 0) return prev;
  return {
    compactActions: prev.compactActions
      ? widthPx < HEADER_LABEL_RESTORE_WIDTH_PX
      : widthPx < HEADER_LABEL_MIN_WIDTH_PX,
    compactTimeframe: prev.compactTimeframe
      ? widthPx < HEADER_TIMEFRAME_RESTORE_WIDTH_PX
      : widthPx < HEADER_TIMEFRAME_FOLD_WIDTH_PX,
  };
}
