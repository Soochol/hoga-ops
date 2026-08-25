import { createWindowScopedRegistry } from './windowScopedRegistry';
import type { PeakWallStepPoint } from '../../chart/peakWallSteps';

export type PeakWallStepSide = 'ask' | 'bid';

/** 한 방향의 계단 — 이미 축 좌표로 투영된 점 배열. pane 프로젝터는 이 값을
 *  **그대로 돌려주기만** 한다(pass-through). */
export type PeakWallStepSlot = {
  points: readonly PeakWallStepPoint[];
};

/**
 * 최대벽 계단의 (창, 방향) → 계단 점 레지스트리.
 *
 * `LiveChartRoot` 가 `usePeakWallRender` 의 세그먼트에서 계단을 `useMemo` 로 한 번
 * 만들어 등록하고, `peak-wall` pane 의 `useContext` 가 자기 창 스코프를 구독한다.
 * pane spec 은 모듈 상수라 props 로 내려줄 수 없어 이 통로가 필요하다 —
 * `dailyMaSeriesRegistry` 와 같은 모양(차트가 만든 것을 다른 표면이 읽는다).
 *
 * ⚠ 세그먼트가 아니라 **이미 투영된 계단 점**을 넣는다. 세그먼트는 보이는 영역
 * 기반 입력 때문에 팬·줌마다 재계산될 수 있는데,
 * 그걸 넣으면 팬 한 번이 스토어 쓰기 → 구독자 재렌더 → 프로젝터 재계산으로
 * 이어진다. 계단을 상류에서 접어 넣으면 pane 은 그리기만 한다.
 *
 * 창 스코프가 필요한 이유는 `windowScopedRegistry` 의 주석 그대로다 — 고정 키를
 * 쓰면 창 B 의 마운트가 창 A 의 값을 덮어쓴다.
 */
export const usePeakWallStepsRegistry =
  createWindowScopedRegistry<PeakWallStepSide, PeakWallStepSlot>();
