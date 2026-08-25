import { describe, it, expect } from 'vitest';
import { PEAK_WALL_SPEC } from './peakWallPaneSpec';
import { PEAK_WALL_STEP_SLOTS } from './peakWallStepsRegistry';

/**
 * 강도 pane 이 **캔들 pane 의 세 선과 1:1** 인가(2026-08-25).
 *
 * 종전 pane 은 계단을 체결된 벽 하나만 날랐다 — 캔들엔 선이 셋인데 pane 엔 하나였다.
 * 계열이 늘 때 레전드 라벨과 데이터 키가 갈리는 것이 이 구조의 고유 실패 모드라
 * (한쪽이 조용히 빈 슬롯을 읽는다), 둘이 **같은 상수에서 파생**되는 것을 값으로 못박는다.
 *
 * 막는 방향: 슬롯 목록과 series 목록이 어긋나는 것.
 * 못 보는 것: 계단 값 자체 — `peakWallSteps.test.ts` 가 본다.
 */
describe('최대벽 강도 pane 슬롯', () => {
  it('방향 2 × 계열 3 = 6 슬롯이고 키가 유일하다', () => {
    expect(PEAK_WALL_STEP_SLOTS).toHaveLength(6);
    expect(new Set(PEAK_WALL_STEP_SLOTS.map((s) => s.key)).size).toBe(6);
    expect(PEAK_WALL_STEP_SLOTS.map((s) => s.key)).toEqual([
      'ask-traded', 'ask-all', 'ask-unreached',
      'bid-traded', 'bid-all', 'bid-unreached',
    ]);
  });

  it('pane series 가 슬롯에서 파생된다 — 라벨과 개수가 함께 움직인다', () => {
    expect(PEAK_WALL_SPEC.series).toHaveLength(PEAK_WALL_STEP_SLOTS.length);
    expect(PEAK_WALL_SPEC.series.map((s) => s.legend.label))
      .toEqual(PEAK_WALL_STEP_SLOTS.map((s) => s.label));
  });

  it('각 series 는 자기 슬롯 키의 계단만 읽는다(키 드리프트 가드)', () => {
    const ctx = Object.fromEntries(
      PEAK_WALL_STEP_SLOTS.map((slot, i) => [slot.key, [{ time: i, value: i }]]),
    ) as never;
    PEAK_WALL_SPEC.series.forEach((series, i) => {
      expect(series.data(null as never, null as never, ctx)).toEqual([{ time: i, value: i }]);
    });
  });
});
