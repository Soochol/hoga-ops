import { describe, expect, it } from 'vitest';
import type { Time } from 'lightweight-charts';
import { createVirtualAxis } from '../util/virtualAxis';
import type { AskPeakCandidate, Candle } from '../api/types';
import type { PeakWallSegment } from '../chart/PeakWallSegmentsPrimitive';
import { buildBarModePanePoints, EMPTY_PEAK_WALL_STEPS } from './peakWallPanePoints';
import { buildPeakWallStepPoints, buildUnreachedStepPoints } from '../chart/peakWallSteps';

const MIN = 60_000;
const OPEN = Date.UTC(2026, 7, 20, 0, 0); // KST 09:00
const axis = createVirtualAxis([
  { date: '20260820', sessionOpenMs: OPEN, sessionCloseMs: OPEN + 6 * MIN },
]);
const candles: Candle[] = [0, 1, 2].map((i) => (
  { ts_ms: OPEN + i * MIN, open: 100, high: 110, low: 90, close: 105, vol_a: 1, vol_b: 1 } as Candle
));

function seg(realMs: number, qty: number, price = 1000): PeakWallSegment {
  const vsec = axis.toVirtual(realMs) / 1000;
  return {
    time0: vsec as Time, time1: vsec as Time, peakTime: vsec as Time,
    price, qty, label: '', color: '#3485FA', lineWidth: 2, live: false,
  } as PeakWallSegment;
}
const cand = (realMs: number, qty: number): AskPeakCandidate => (
  { price: 1000, qty, t_ms: realMs }
);

const base = {
  paneEnabled: true,
  stepBuilder: buildPeakWallStepPoints,
  candles,
  axis,
  color: '#3485FA',
};

/**
 * 표현 모드 분기 — 이 pane 이 **어느 질문에 답하는가**를 고르는 자리.
 *
 * 이 파일이 존재하는 이유가 곧 그 위험이다: 분기가 `LiveChartRoot` 안에 인라인일 때는
 * 통째로 지워도 프론트 전 스위트가 초록이었다(red-check 실측).
 *
 * **막는 방향**: 모드를 무시하고 한쪽만 그리는 것 · `bar` 에서 데이터가 없을 때 계단으로
 * 떨어지는 것 · pane 이 꺼졌는데 계산하는 것.
 * **못 보는 것**: 점 값 자체(`peakWallSteps.test.ts`) · 어느 계열이 이 함수에 오는가
 * (`LiveChartRoot` 의 배선 — 전체·미도달은 오지 않는다).
 */
describe('buildBarModePanePoints', () => {
  const barCandidates = [cand(OPEN + 1 * MIN, 5_000)];
  const stepSegments = [seg(OPEN + 1 * MIN, 5_000)];

  it('step 모드는 세그먼트로 누적 계단을 만든다', () => {
    const points = buildBarModePanePoints({
      ...base, mode: 'step', barCandidates, stepSegments,
    });
    // 첫 벽 이전 봉엔 점이 없다(누적 빌더 규약) — 봉별과 개수부터 다르다.
    expect(points.map((p) => p.value)).toEqual([5_000, 5_000]);
  });

  it('bar 모드는 후보로 봉별 점을 만든다 — 빈 봉이 0 으로 남는다', () => {
    const points = buildBarModePanePoints({
      ...base, mode: 'bar', barCandidates, stepSegments,
    });
    expect(points.map((p) => p.value)).toEqual([0, 5_000, 0]);
  });

  it('bar 모드에서 후보가 없으면 **계단으로 떨어지지 않는다**', () => {
    // 세그먼트는 있다 — 폴백이 있으면 여기서 계단이 나온다. 모드를 바꿨는데 같은
    // 그림이 나오면 "안 먹었다" 로 읽히므로 빈 pane 이 정직하다.
    const points = buildBarModePanePoints({
      ...base, mode: 'bar', barCandidates: [], stepSegments,
    });
    expect(points).toBe(EMPTY_PEAK_WALL_STEPS);
  });

  it('step 모드에서 세그먼트가 없으면 봉별 후보를 쓰지 않는다', () => {
    const points = buildBarModePanePoints({
      ...base, mode: 'step', barCandidates, stepSegments: [],
    });
    expect(points).toBe(EMPTY_PEAK_WALL_STEPS);
  });

  it('pane 이 꺼져 있으면 어느 모드든 계산하지 않는다', () => {
    for (const mode of ['step', 'bar'] as const) {
      expect(buildBarModePanePoints({
        ...base, paneEnabled: false, mode, barCandidates, stepSegments,
      })).toBe(EMPTY_PEAK_WALL_STEPS);
    }
  });

  it('계단 빌더는 **주입된 것**을 쓴다 — 미도달은 비단조 판이어야 한다', () => {
    // 캔들 고가가 110 이라 가격 105 벽은 이미 도달된 상태다.
    // running max 는 그래도 값을 내고, 미도달 빌더는 **아무것도 내지 않는다**.
    const reached = [seg(OPEN + 1 * MIN, 5_000, 105)];
    const asRunningMax = buildBarModePanePoints({
      ...base, mode: 'step', barCandidates: [], stepSegments: reached,
    });
    const asUnreached = buildBarModePanePoints({
      ...base,
      mode: 'step',
      barCandidates: [],
      stepSegments: reached,
      stepBuilder: (segs, c, a, color) => buildUnreachedStepPoints(segs, c, a, color, 'ask'),
    });
    expect(asRunningMax.length).toBeGreaterThan(0);
    // 주입이 무시되면(항상 running max) 이 줄이 실패한다.
    expect(asUnreached).toEqual([]);
  });

  it('빈 결과는 **공유 참조**다 — 발행 훅의 멱등 조건이 여기 기댄다', () => {
    const a = buildBarModePanePoints({ ...base, mode: 'bar', barCandidates: [], stepSegments: [] });
    const b = buildBarModePanePoints({ ...base, mode: 'step', barCandidates: [], stepSegments: [] });
    expect(a).toBe(b);
  });
});
