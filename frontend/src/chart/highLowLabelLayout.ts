import type { Time } from 'lightweight-charts';
import { LABEL_BOX_X_PAD_PX, LABEL_BOX_Y_PAD_PX, LABEL_FONT_PX, LABEL_GAP_PX } from './AskPeakSegmentsPrimitive';
import { RENDERED_ROOT_PX, SIZE_TOKENS } from '../styles/design-tokens';

/**
 * 고저 극값 라벨(CONTEXT.md `High/Low Extreme Labels`)의 **순수 기하**. 좌표계는 캔들
 * pane 로컬 CSS 픽셀 — HighLowLabelsPrimitive 가 media coordinate space 에서 그대로 쓴다.
 * lightweight-charts 비의존이라 캔버스 없이 단위 테스트된다.
 */

/** Ask/Bid Peak(최대벽) 도킹 라벨 1개의 회피 입력 — 가격(y)·선 끝 시각(x)·라벨 텍스트(폭). */
export type AvoidWallLabel = {
  price: number;
  time1: Time;
  label: string;
};

/** 회피 대상 rect — 캔들 pane 로컬 px 좌표. */
export type AvoidRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type ExtremeLabelPlace = 'above' | 'below';

export type ExtremeLabelPlacement = {
  x: number;
  y: number;
  place: ExtremeLabelPlace;
};

export const LABEL_EDGE_PAD_PX = 6;
export const LABEL_HEIGHT_PX = 16;
export const LEADER_MIN_HEIGHT_PX = 3;
export const LABEL_AVOID_GAP_PX = 2;
/** 칩 좌우 여백 — DOM 시절 padding '1px 5px' 의 x 성분. */
export const LABEL_BOX_PAD_X_PX = 5;
export const LABEL_BOX_RADIUS_PX = 3;
/** dot 반지름과 배경색 링 두께 — DOM 시절 6px 원 + 1.5px boxShadow 링. */
export const DOT_RADIUS_PX = 3;
export const DOT_RING_PX = 1.5;
export const LEADER_OPACITY = 0.45;
/**
 * 극값 **가격선**(pane 전폭 수평 점선)의 획 스타일. 리더선(0.45 / [3,3])보다 옅고
 * 성글다 — 리더선은 dot↔칩 사이 수십 px 이지만 이 선은 pane 을 가로지르므로 같은
 * 무게를 주면 캔들보다 선이 먼저 읽힌다. VI/상하한가 선(실선 + 사용자 지정 색·두께)
 * 과 점선/실선으로 갈려 두 레이어가 겹쳐도 구분된다.
 */
export const LEVEL_LINE_OPACITY = 0.28;
export const LEVEL_LINE_DASH: readonly number[] = [4, 4];
/**
 * 이전일 고저선의 dash — 극값 가격선([4,4])보다 **길다**. 두 기능을 동시에 켜면 색은
 * 같은 방향색이라(정보가 방향이므로 바꾸지 않는다) 구분은 dash 가 진다. 사용자가
 * 두께를 바꿔도 이 비율은 유지된다.
 */
export const PRIOR_LINE_DASH: readonly number[] = [8, 4];
/**
 * 캔버스는 CSS rem 을 못 읽으므로 `--text-xs` 를 px 로 환산해 둔다. **손으로 계산한
 * 숫자를 박지 말 것** — 2026-08-07 다이얼 변경(18→16px) 전까지 여기엔 `11.8` 이
 * 상수로 박혀 있었고, 다이얼이 움직여도 타입 에러도 테스트 실패도 없이 이 라벨만
 * 옛 밀도에 남는 상태였다. 파생식이면 다이얼이 곧 진실이다.
 */
export const HIGHLOW_FONT_PX = SIZE_TOKENS['text-xs'].rem * RENDERED_ROOT_PX;
export const HIGHLOW_FONT_WEIGHT = 600;
/** 폭 근사 — canvas measureText 를 못 쓰는 경로(레이아웃 단위 테스트) 폴백. */
const LABEL_CHAR_WIDTH_PX = 6.6;
// 도킹 라벨(11px sans-serif, 숫자·콤마 위주) 폭 추정 — canvas measureText 없이 근사.
// 약간 넉넉하게 잡아 회피 rect 가 실제 칩보다 좁아지는 쪽(겹침 잔존)을 피한다.
const WALL_LABEL_CHAR_WIDTH_PX = 6.5;
// 도킹 라벨 x 간격 — PeakWallDockedLabelsPrimitive.draw 의 labelXGapPx(6*hr)와 동일.
const WALL_LABEL_X_GAP_PX = 6;
// 회피 연쇄 push 상한(pane 높이 비율). 이보다 깊이 밀 바엔 겹침을 감수하고 가장자리로
// 복귀한다 — 회피가 라벨을 pane 중간까지 표류시키던 최악 케이스의 구조적 차단.
const MAX_AVOID_SHIFT_RATIO = 0.3;

/** 칩 전체 폭(텍스트 + 좌우 패딩). measured 는 canvas measureText 결과. */
export function labelBoxWidth(measuredTextWidth: number): number {
  return measuredTextWidth + LABEL_BOX_PAD_X_PX * 2;
}

/** measureText 없이 쓰는 칩 폭 근사 — 레이아웃 테스트·캔버스 없는 경로용. */
export function estimateLabelWidth(text: string): number {
  return labelBoxWidth(text.length * LABEL_CHAR_WIDTH_PX);
}

type VerticalBox = {
  top: number;
  bottom: number;
};

// 가장자리 고정 라벨 박스. anchorY 는 라벨의 pane-가장자리 쪽 모서리:
// 'above'(고가)=상단 가장자리에서 아래로, 'below'(저가)=하단 가장자리에서 위로.
function highLowLabelBox(anchorY: number, place: ExtremeLabelPlace): VerticalBox {
  return place === 'above'
    ? { top: anchorY, bottom: anchorY + LABEL_HEIGHT_PX }
    : { top: anchorY - LABEL_HEIGHT_PX, bottom: anchorY };
}

/** 도킹 라벨 칩 rect 근사 — PeakWallDockedLabelsPrimitive 의 렌더 기하를 미러링:
 *  선 y 위 baseline(lineY-GAP), 선 끝 x 우측(x-gap + halfBarSpacing anchor shift). */
export function wallLabelAvoidRect(
  lineY: number,
  lineEndX: number,
  label: string,
  halfBarSpacingPx: number,
): AvoidRect {
  const baselineY = lineY - LABEL_GAP_PX;
  const estWidth = label.length * WALL_LABEL_CHAR_WIDTH_PX;
  const left = lineEndX + WALL_LABEL_X_GAP_PX + halfBarSpacingPx - LABEL_BOX_X_PAD_PX;
  return {
    top: baselineY - LABEL_FONT_PX - LABEL_BOX_Y_PAD_PX,
    bottom: baselineY + LABEL_BOX_Y_PAD_PX,
    left,
    right: left + estWidth + LABEL_BOX_X_PAD_PX * 2,
  };
}

export function placeExtremeLabel(
  preferred: ExtremeLabelPlace,
  x: number,
  y: number,
  labelWidth: number,
  paneWidth: number,
  paneHeight: number,
  avoidRects: readonly AvoidRect[] = [],
): ExtremeLabelPlacement {
  if (paneWidth <= 0 || paneHeight <= 0) return { x, y, place: preferred };
  // x: dot(극값 봉) x 를 유지하되 라벨 폭 절반이 pane 좌우 가장자리를 넘지 않게 클램프.
  const halfWidth = labelWidth / 2;
  const minX = LABEL_EDGE_PAD_PX + halfWidth;
  const maxX = Math.max(minX, paneWidth - LABEL_EDGE_PAD_PX - halfWidth);
  const placedX = Math.min(maxX, Math.max(minX, x));

  // 라벨은 가격이 아니라 pane 가장자리에 고정한다: 고가('above')=상단, 저가('below')=하단.
  // 반전 없음 — dot 은 극값 가격 위치에 남고 렌더 단 리더선이 dot↔라벨을 잇는다.
  const place = preferred;
  const minY = LABEL_EDGE_PAD_PX;
  const maxY = paneHeight - LABEL_EDGE_PAD_PX;
  const edgeAnchorY = place === 'above' ? minY : maxY;
  let anchorY = edgeAnchorY;

  // 다른 라벨(도킹 wall 칩·pane 레전드 행)과 겹치면 pane 안쪽으로 양보: 상단 라벨은
  // 아래로, 하단 라벨은 위로 민다(가장자리 고정의 역방향 push). 회피는 **2D** — 라벨
  // 박스와 x·y 모두 교차하는 rect 만 실효한다. y-전용이던 옛 방식은 우측에 도킹된 wall
  // 칩이 좌측 극값 라벨을 밀어내는 유령 push 로 라벨을 pane 중간까지 표류시켰다.
  if (avoidRects.length > 0) {
    const labelLeft = placedX - halfWidth;
    const labelRight = placedX + halfWidth;
    const overlappingX = avoidRects
      .filter((r) => (
        Number.isFinite(r.top) && Number.isFinite(r.bottom)
        && Number.isFinite(r.left) && Number.isFinite(r.right)
        && labelLeft < r.right && r.left < labelRight
      ))
      .sort((a, b) => (place === 'above' ? a.top - b.top : b.bottom - a.bottom));
    for (const box of overlappingX) {
      const labelBox = highLowLabelBox(anchorY, place);
      if (labelBox.top < box.bottom && box.top < labelBox.bottom) {
        anchorY = place === 'above'
          ? box.bottom + LABEL_AVOID_GAP_PX
          : box.top - LABEL_AVOID_GAP_PX;
      }
    }
    // 연쇄 push 상한 — 겹겹이 쌓인 회피 대상을 따라 pane 중간까지 밀리느니 가장자리
    // 원위치로 복귀한다(겹침 감수). "저가 라벨이 pane 중간에 뜨는" 케이스의 최종 방벽.
    if (Math.abs(anchorY - edgeAnchorY) > paneHeight * MAX_AVOID_SHIFT_RATIO) {
      anchorY = edgeAnchorY;
    }
  }

  // 라벨 박스 전체가 pane 안에 머물도록 앵커 클램프.
  const anchorMin = place === 'above' ? minY : minY + LABEL_HEIGHT_PX;
  const anchorMax = place === 'above' ? maxY - LABEL_HEIGHT_PX : maxY;
  const placedY = Math.min(anchorMax, Math.max(anchorMin, anchorY));
  return { x: placedX, y: placedY, place };
}
