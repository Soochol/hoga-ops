import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PeakWallStepPoint } from '../../chart/peakWallSteps';
import { scopeEntries } from './windowScopedRegistry';
import {
  PEAK_WALL_STEP_SLOTS,
  usePeakWallStepsPublisher,
  usePeakWallStepsRegistry,
  type PeakWallStepPointsInput,
} from './peakWallStepsRegistry';

/** pane 이 꺼진 상태의 공유 빈 배열 — `LiveChartRoot` 의 `EMPTY_PEAK_WALL_STEPS` 미러. */
const EMPTY: readonly PeakWallStepPoint[] = [];

function inputOf(over: Partial<PeakWallStepPointsInput> = {}): PeakWallStepPointsInput {
  const base = Object.fromEntries(
    PEAK_WALL_STEP_SLOTS.map((s) => [s.key, EMPTY]),
  ) as Record<string, readonly PeakWallStepPoint[]>;
  return { ...base, ...over } as PeakWallStepPointsInput;
}

/** 스토어 쓰기 횟수 — 구독은 `setState` 안에서 동기적으로 돈다. */
function countWrites(run: () => void): number {
  let n = 0;
  const off = usePeakWallStepsRegistry.subscribe(() => { n += 1; });
  run();
  off();
  return n;
}

describe('usePeakWallStepsPublisher', () => {
  beforeEach(() => {
    usePeakWallStepsRegistry.setState({ byScope: new Map() });
  });

  it('첫 마운트에서 여섯 칸을 등록한다', () => {
    const points = inputOf();
    renderHook(() => usePeakWallStepsPublisher('w1', points));
    expect(scopeEntries(usePeakWallStepsRegistry.getState().byScope, 'w1').size)
      .toBe(PEAK_WALL_STEP_SLOTS.length);
  });

  it('**점 배열이 그대로면 쓰지 않는다** — 상류 memo 가 새 객체를 내도', () => {
    const points = inputOf();
    const { rerender } = renderHook(
      ({ p }: { p: PeakWallStepPointsInput }) => usePeakWallStepsPublisher('w1', p),
      { initialProps: { p: points } },
    );
    // 이것이 회귀의 형태다: 축·캔들·벽이 움직이면 상류 `useMemo` 가 **새 객체**를 내는데,
    // 칸의 배열은 그대로다(특히 pane 이 꺼져 있으면 전부 같은 빈 배열 상수).
    // 종전 판은 여기서 `{ points }` 래퍼를 새로 만들어 6회 썼고, 그 알림이 SyncLane 이라
    // 커밋마다 nested-update 계수를 올려 "Maximum update depth exceeded" 로 이어졌다.
    const writes = countWrites(() => rerender({ p: inputOf() }));
    expect(writes).toBe(0);
  });

  it('바뀐 칸만 쓴다 — 갱신을 삼키지도 않는다', () => {
    const points = inputOf();
    const { rerender } = renderHook(
      ({ p }: { p: PeakWallStepPointsInput }) => usePeakWallStepsPublisher('w1', p),
      { initialProps: { p: points } },
    );
    const grown: readonly PeakWallStepPoint[] = [
      { time: 1 as never, value: 100, color: '#f00' } as unknown as PeakWallStepPoint,
    ];
    const writes = countWrites(() => rerender({ p: inputOf({ 'ask-traded': grown }) }));
    expect(writes).toBe(1);
    expect(scopeEntries(usePeakWallStepsRegistry.getState().byScope, 'w1').get('ask-traded')?.points)
      .toBe(grown);
  });

  it('언마운트에서 그 창의 칸을 전부 걷는다', () => {
    const { unmount } = renderHook(() => usePeakWallStepsPublisher('w1', inputOf()));
    unmount();
    expect(scopeEntries(usePeakWallStepsRegistry.getState().byScope, 'w1').size).toBe(0);
  });

  it('창이 다르면 서로의 칸을 건드리지 않는다', () => {
    renderHook(() => usePeakWallStepsPublisher('w1', inputOf()));
    renderHook(() => usePeakWallStepsPublisher('w2', inputOf()));
    expect(scopeEntries(usePeakWallStepsRegistry.getState().byScope, 'w1').size).toBe(6);
    expect(scopeEntries(usePeakWallStepsRegistry.getState().byScope, 'w2').size).toBe(6);
  });
});
