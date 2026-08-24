import type { PaneId } from '../chart/drawing/types';
import { PANE_DISPLAY_NAME } from '../chart/paneOrder';
import { isSharedAxisGroup, paneGroupIndexOf, type PaneGroups } from '../chart/paneGroups';
import { paneSpecsForTimeframe, type PaneToggles } from './paneSpecsForTimeframe';
import type { PaneSpecGroup } from './paneGroupSpecs';

/**
 * pane 병합 드래그의 순수 판정 — 레전드 칩 드래그 중 포인터 y 좌표를
 * 「어느 pane 에 합치기 / 어느 경계로 이동·분리」로 분류한다.
 *
 * 지오메트리(paneTops/paneHeights)는 PaneLegendOverlay 가 이미 레전드 Y 배치에
 * 쓰는 것과 **같은 소스**(`chart.panes()[i].getHeight()` 누적)를 받는다 —
 * 드롭 존과 화면이 어긋날 수 없다.
 */

/** 드래그 시작 임계값 — 칩이 ✕·↑↓ 옆에 있어 클릭 오조작을 막는다. 이 미만의
 *  이동 후 pointerup 은 클릭(메뉴 열기)으로 처리된다. */
export const PANE_DRAG_THRESHOLD_PX = 6;

/** 경계 밴드 반높이 — 경계선 ±이 값 안이면 「경계 드롭」, 밖이면 「pane 본체」. */
export const PANE_BOUNDARY_BAND_PX = 8;

export type PaneDropTarget =
  /** pane 본체 드롭 = 그 pane 그룹으로 병합. `targetPane` 은 그룹 대표(첫 멤버). */
  | { kind: 'merge'; targetPane: PaneId; paneIndex: number }
  /** 경계 드롭 = 그 위치로 이동/분리. `boundaryIndex` 는 **보이는 그룹 좌표**의
   *  경계(1 = candle 바로 아래 … n = 맨 아래). `yPx` 는 삽입선을 그릴 y. */
  | { kind: 'boundary'; boundaryIndex: number; yPx: number };

export function classifyPaneDropTarget(input: {
  yPx: number;
  paneTops: readonly number[];
  paneHeights: readonly number[];
  /** 보이는 그룹 목록 — paneTops 와 index 정렬(레전드 렌더와 동일). */
  groups: readonly PaneSpecGroup[];
  draggedPane: PaneId;
}): PaneDropTarget | null {
  const { yPx, paneTops, paneHeights, groups, draggedPane } = input;
  const n = Math.min(groups.length, paneTops.length, paneHeights.length);
  if (n === 0) return null;
  const draggedIdx = groups.findIndex((g) => g.some((s) => s.name === draggedPane));
  const draggedSolo = draggedIdx >= 0 && groups[draggedIdx].length === 1;

  // 경계 우선 — 경계 밴드는 pane 본체보다 좁으니 먼저 판정해야 pane 이 삼키지 않는다.
  // 경계 i = pane i 의 상단 (i = 1..n-1) + 맨 아래(i = n). 경계 0(candle 위)은 불허.
  for (let i = 1; i <= n; i += 1) {
    const y = i < n ? paneTops[i] : paneTops[n - 1] + paneHeights[n - 1];
    if (Math.abs(yPx - y) > PANE_BOUNDARY_BAND_PX) continue;
    // 싱글턴이 자기 위/아래 경계로 가는 것은 무의미 이동 — 타겟 없음으로 처리해
    // 하이라이트가 "무슨 일이 일어난다" 고 거짓말하지 않게 한다.
    if (draggedSolo && (i === draggedIdx || i === draggedIdx + 1)) return null;
    return { kind: 'boundary', boundaryIndex: i, yPx: y };
  }

  // pane 본체 — candle(0)과 자기 그룹은 타겟이 아니다.
  for (let i = 0; i < n; i += 1) {
    if (yPx < paneTops[i] || yPx >= paneTops[i] + paneHeights[i]) continue;
    if (i === 0) return null;
    if (i === draggedIdx) return null;
    return { kind: 'merge', targetPane: groups[i][0].name, paneIndex: i };
  }
  return null;
}

/**
 * 보이는 그룹 좌표의 경계를 **전체 paneGroups 좌표**로 옮긴다 — 게이트·접기로
 * 안 보이는 그룹이 사이에 있어도 "보이는 이웃 기준 그 자리" 가 유지되도록
 * 보이는 그룹 vb 의 전체 인덱스 앞(또는 마지막 뒤)으로 매핑한다.
 */
export function fullBoundaryIndex(
  paneGroups: PaneGroups,
  visibleGroups: readonly PaneSpecGroup[],
  boundaryIndex: number,
): number {
  if (visibleGroups.length === 0) return paneGroups.length;
  if (boundaryIndex >= visibleGroups.length) {
    const last = visibleGroups[visibleGroups.length - 1];
    return paneGroupIndexOf(paneGroups, last[0].name) + 1;
  }
  return paneGroupIndexOf(paneGroups, visibleGroups[boundaryIndex][0].name);
}

/** 받침 유무에 따른 을/를. */
function eulReul(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return '을(를)';
  return (last - 0xac00) % 28 > 0 ? '을' : '를';
}

/**
 * 게이트가 겹치는가 — 두 pane 이 **어떤 타임프레임에서든 함께 표시될 수 있는가**.
 * 게이트 지식을 여기 복제하지 않고 `paneSpecsForTimeframe` 자체에 물어 파생한다
 * (분봉 + D 두 관점이면 충분 — W/M 의 마운트 집합은 D 의 부분집합이다).
 *
 * ⚠ `ALL_ON` 은 **모든 opt-in 토글을 켜야 한다** — 빠진 pane 은 두 집합 어디에도
 * 없어 어떤 조합이든 거짓 게이트 경고가 뜬다(peak-wall 이 실제 사례: 교차 PR 로
 * `peakWallPaneEnabled === true` 게이트가 들어오며 이 함정이 생겼다). 새 opt-in
 * pane 토글을 추가하면 여기에도 추가할 것 — `paneMergeDrag.test.ts` 의 전수
 * 가드(모든 PaneId 는 어딘가에서 보인다)가 누락을 빨갛게 만든다.
 */
const ALL_ON: PaneToggles = {
  foreignNet: true,
  institutionNet: true,
  peakWallPaneEnabled: true,
};
let coVisibleSets: { minute: Set<string>; daily: Set<string> } | null = null;
/** 두 pane 이 같은 타임프레임에서 함께 마운트될 수 있는가(최대 토글 기준). */
export function panesCanCoDisplay(a: PaneId, b: PaneId): boolean {
  if (!coVisibleSets) {
    coVisibleSets = {
      minute: new Set(paneSpecsForTimeframe('1m', ALL_ON).map((s) => s.name)),
      daily: new Set(paneSpecsForTimeframe('D', ALL_ON).map((s) => s.name)),
    };
  }
  const { minute, daily } = coVisibleSets;
  return (minute.has(a) && minute.has(b)) || (daily.has(a) && daily.has(b));
}

export type MergeDropHint = {
  title: string;
  /** 축 처리 예고 또는 게이트 경고 — 배너 둘째 줄. */
  hint: string;
  /** 게이트 경고(함께 표시 불가 조합)면 true — 시각적으로 경고 톤을 쓴다. */
  warning: boolean;
};

/** 병합 드롭 배너의 문구 — 결과(어디에 합쳐지는가)와 축 처리(공유/격리)를 예고한다. */
export function mergeDropHint(
  draggedPane: PaneId,
  targetGroupIds: readonly PaneId[],
): MergeDropHint {
  const name = PANE_DISPLAY_NAME[draggedPane];
  const title = `『${name}』${eulReul(name)} 이 pane 에 합치기`;
  if (targetGroupIds.some((id) => !panesCanCoDisplay(draggedPane, id))) {
    return {
      title,
      hint: '이 조합은 같은 타임프레임에서 함께 표시되지 않습니다',
      warning: true,
    };
  }
  if (isSharedAxisGroup([...targetGroupIds, draggedPane])) {
    return { title, hint: '같은 주 단위 · ± 순매수 — y축을 공유합니다', warning: false };
  }
  return { title, hint: '각자 스케일로 겹칩니다 · 값은 레전드·크로스헤어로', warning: false };
}

/** 경계 드롭 라벨 — 병합 pane 에서 끌어냈으면 「분리」, 싱글턴이면 「이동」. */
export function boundaryDropLabel(fromMergedGroup: boolean): string {
  return fromMergedGroup ? '여기에 새 pane 으로 분리' : '여기로 이동';
}
