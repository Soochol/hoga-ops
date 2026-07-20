import type { BoundPaneSpec } from '../chart/paneSpecs';

/**
 * Pane 접기(점진적 degradation) — 창이 작아질 때 모든 pane 을 비례 축소만 하면 전부
 * 읽을 수 없게 된다. 우선순위가 낮은 pane 부터 화면에서 빼고 남은 공간을 캔들이
 * 흡수하게 해서, 남은 것만큼은 끝까지 읽히게 한다. 창을 줄였는데 정작 보려던 캔들은
 * 오히려 커진다.
 *
 * **이것은 렌더 시점 파생값이다.** 저장된 지표 설정(`live.indicators.v2`)이나
 * `paneStretch` 에는 절대 쓰지 않는다 — 창을 줄였다는 이유로 사용자가 맞춰둔 지표
 * 구성이 사라지면 안 되고, 창을 다시 키우면 접혔던 pane 이 그대로 돌아와야 한다.
 * 보조지표 드로어도 계속 "켜짐"으로 보여야 한다(실제로 켜져 있고 지금 크기에서
 * 안 그려질 뿐이다).
 *
 * 접는 순서는 새로 정하지 않는다 — `paneSpecsForTimeframe` 이 이미 `paneOrder`
 * (사용자 소유, ADR-0114 §3)로 정렬해 넘겨주므로 **배열 끝부터** 접는다. 아래에
 * 뒀다는 건 덜 중요하게 봤다는 뜻이다. 캔들은 index 0 고정이라 절대 접히지 않는다.
 */

/** lightweight-charts 시간축 위젯 높이(v5.2.0 기본 폰트 실측 28px)와 pane 구분선
 *  높이. 임계 계산에만 쓰이므로 몇 px 오차는 임계가 그만큼 이동할 뿐 무해하다 —
 *  실제 배분은 lwc 가 stretch 로 하고 이 값들은 "몇 px 남는가" 추정에만 쓰인다. */
export const TIME_AXIS_PX = 28;
const SEPARATOR_PX = 1;

/** 보조 pane 이 정보를 담을 수 있는 최소 높이. 이보다 작으면 선이 몇 px 위아래로
 *  떨리는 것밖에 안 보여 정보가 아니라 노이즈다 — 접고 공간을 캔들에 주는 게 낫다. */
export const MIN_AUX_PANE_PX = 40;
/** 히스테리시스 dead band 의 상단. 되살릴 때는 접을 때보다 여유가 더 있어야 한다.
 *  같은 값을 쓰면 임계 근처에서 드래그하다 손이 미세하게 흔들릴 때 pane 이
 *  나타났다 사라졌다 깜빡인다. */
export const UNFOLD_AUX_PANE_PX = 48;

/** 보조가 전부 접힌 뒤에도 캔들이 이보다 작으면 시간축까지 숨겨 28px 를 캔들에
 *  돌려준다(글랜스 티어). 절대 시각은 크로스헤어 툴팁이 대신한다. */
export const HIDE_TIME_AXIS_BELOW_PX = 140;
/** 시간축 복귀 임계 — 위와 같은 이유의 dead band. */
export const SHOW_TIME_AXIS_ABOVE_PX = 160;

export type PaneFoldState = {
  /** 직전에 접혀 있던 pane 수. 히스테리시스의 기준점이다. */
  foldedCount: number;
  /** 직전 시간축 표시 여부. */
  timeAxisVisible: boolean;
};

export const INITIAL_FOLD_STATE: PaneFoldState = Object.freeze({
  foldedCount: 0,
  timeAxisVisible: true,
});

export type PaneFoldResult = PaneFoldState & {
  /** 실제로 마운트할 pane 목록 — 접힌 것을 제외한 앞쪽 슬라이스. */
  specs: readonly BoundPaneSpec[];
};

/** pane 별 유효 stretch: 저장된 Pane Stretch(#703) 우선, 없으면 스펙 기본값. */
export type StretchOf = (spec: BoundPaneSpec) => number;

/**
 * 주어진 최소 가독 높이 기준으로 "몇 개를 접어야 남은 보조 pane 이 전부 그 높이를
 * 받는가". 끝에서부터 하나씩 접어보며 처음 조건을 만족하는 수를 돌려준다.
 * 최소 가독 높이가 클수록 더 많이 접게 되므로 반환값은 `minAuxPx` 에 대해 단조증가 —
 * 이 단조성이 히스테리시스 dead band 가 성립하는 근거다.
 */
function foldedCountFor(
  specs: readonly BoundPaneSpec[],
  heightPx: number,
  stretchOf: StretchOf,
  minAuxPx: number,
): number {
  const maxFold = Math.max(0, specs.length - 1); // 캔들은 남긴다
  for (let folded = 0; folded < maxFold; folded += 1) {
    const kept = specs.length - folded;
    const budget = heightPx - TIME_AXIS_PX - (kept - 1) * SEPARATOR_PX;
    if (budget <= 0) continue; // 크롬조차 못 담는다 — 더 접는다
    let total = 0;
    for (let i = 0; i < kept; i += 1) total += stretchOf(specs[i]);
    if (total <= 0) continue;
    // 보조 pane 중 가장 작은 것이 기준 — 그게 통과하면 나머지도 통과한다.
    let minAux = Number.POSITIVE_INFINITY;
    for (let i = 1; i < kept; i += 1) {
      minAux = Math.min(minAux, (budget * stretchOf(specs[i])) / total);
    }
    if (minAux >= minAuxPx) return folded;
  }
  return maxFold;
}

/**
 * 창 높이에 맞춰 접을 pane 을 결정한다. `prev` 는 직전 결과로, dead band 안에서는
 * 그대로 유지해 임계 근처 깜빡임을 막는다.
 *
 * `heightPx` 가 아직 측정되지 않았으면(0 이하) 아무것도 접지 않는다 — 마운트 직후
 * ResizeObserver 가 첫 값을 주기 전에 전부 접었다가 펴는 게 훨씬 나쁘다.
 */
export function foldPanes(
  specs: readonly BoundPaneSpec[],
  heightPx: number,
  stretchOf: StretchOf,
  prev: PaneFoldState = INITIAL_FOLD_STATE,
): PaneFoldResult {
  if (!(heightPx > 0) || specs.length === 0) {
    return { specs, foldedCount: 0, timeAxisVisible: true };
  }

  // specs.length 는 봉 전환·지표 토글로 바뀐다 — 직전 값을 현재 범위로 먼저 조인다.
  const maxFold = Math.max(0, specs.length - 1);
  const prevFolded = Math.min(Math.max(prev.foldedCount, 0), maxFold);

  const tight = foldedCountFor(specs, heightPx, stretchOf, MIN_AUX_PANE_PX);
  const loose = foldedCountFor(specs, heightPx, stretchOf, UNFOLD_AUX_PANE_PX);

  // dead band = [tight, loose]. 아래로 벗어나면 더 접고, 위로 벗어나면 되살린다.
  let foldedCount = prevFolded;
  if (prevFolded < tight) foldedCount = tight;
  else if (prevFolded > loose) foldedCount = loose;

  // 접은 게 없으면 원본 참조를 그대로 — `paneSpecsForTimeframe` 의 캐시 identity 를
  // 보존해야 하위 effect(stretch 재적용)와 `RangeSeriesPane` 의 spec-keyed 재조정이
  // 매 프레임 churn 하지 않는다.
  const kept = foldedCount === 0 ? specs : specs.slice(0, specs.length - foldedCount);

  // 시간축은 보조가 전부 접힌 뒤에만 후보가 된다 — 보조가 남아있는데 시간축부터
  // 숨기면 "무엇의 시각인지" 모르는 채 지표만 남는다.
  let timeAxisVisible = true;
  if (kept.length <= 1) {
    const candleWithAxis = heightPx - TIME_AXIS_PX;
    timeAxisVisible = prev.timeAxisVisible
      ? candleWithAxis >= HIDE_TIME_AXIS_BELOW_PX
      : candleWithAxis >= SHOW_TIME_AXIS_ABOVE_PX;
  }

  return { specs: kept, foldedCount, timeAxisVisible };
}
