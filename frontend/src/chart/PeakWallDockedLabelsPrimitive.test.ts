import { describe, expect, it } from 'vitest';
import {
  dockedLabelTimeToX,
  peakWallDockedLabelCandidates,
  type PeakWallDockedLabelInput,
} from './PeakWallDockedLabelsPrimitive';
import type { ITimeScaleApi, Time } from 'lightweight-charts';

describe('peakWallDockedLabelCandidates', () => {
  const labels: PeakWallDockedLabelInput[] = [
    { price: 24500, label: '24,500, 16.6k', color: '#f97316', time1: 120 as Time },
    { price: 23500, label: '23,500, 17.2k', color: '#ec4899', time1: 130 as Time },
    { price: 23000, label: '', color: '#60a5fa', time1: 140 as Time },
  ];

  it('places visible labels after each line endpoint inside the right padding', () => {
    const out = peakWallDockedLabelCandidates(
      labels,
      (price) => (price === 24500 ? 100 : price === 23500 ? 104 : 108),
      780,
      (text) => text.length * 5,
      3,
      (time) => (time === 120 ? 650 : time === 130 ? 660 : 670),
      6,
    );

    expect(out).toEqual([
      { index: 0, xRight: 650 + 6 + '24,500, 16.6k'.length * 5, yLine: 97, width: '24,500, 16.6k'.length * 5, segmentWidth: Number.POSITIVE_INFINITY },
      { index: 1, xRight: 660 + 6 + '23,500, 17.2k'.length * 5, yLine: 101, width: '23,500, 17.2k'.length * 5, segmentWidth: Number.POSITIVE_INFINITY },
    ]);
  });

  it('can shift docked labels past the latest candle body before measuring room', () => {
    const width = '24,500, 16.6k'.length * 5;
    const out = peakWallDockedLabelCandidates(
      labels.slice(0, 1),
      () => 100,
      780,
      (text) => text.length * 5,
      3,
      () => 650,
      6,
      7,
    );

    expect(out).toEqual([
      { index: 0, xRight: 650 + 6 + 7 + width, yLine: 97, width, segmentWidth: Number.POSITIVE_INFINITY },
    ]);
  });

  it('hides shifted labels when the latest candle plus label leaves no right-padding room', () => {
    const out = peakWallDockedLabelCandidates(
      labels.slice(0, 1),
      () => 100,
      700,
      () => 40,
      3,
      () => 650,
      6,
      8,
    );

    expect(out).toEqual([]);
  });

  it('hides labels when the line endpoint leaves no right-padding room', () => {
    const out = peakWallDockedLabelCandidates(
      labels.slice(0, 1),
      () => 100,
      700,
      () => 80,
      3,
      () => 650,
      6,
    );

    expect(out).toEqual([]);
  });

  it('skips labels whose price is not mappable to a y coordinate', () => {
    const out = peakWallDockedLabelCandidates(
      labels,
      (price) => (price === 24500 ? 100 : null),
      780,
      (text) => text.length,
      3,
      () => 650,
      6,
    );

    expect(out.map((candidate) => candidate.index)).toEqual([0]);
  });

  it('supports bitmap-scaled y coordinates by taking a scaled gap', () => {
    const out = peakWallDockedLabelCandidates(
      labels.slice(0, 1),
      () => 100,
      780,
      () => 42,
      6,
      () => 650,
      8,
    );

    expect(out).toEqual([
      { index: 0, xRight: 700, yLine: 94, width: 42, segmentWidth: Number.POSITIVE_INFINITY },
    ]);
  });
});

function timeScaleStub(overrides: Partial<Record<'timeToCoordinate' | 'timeToIndex' | 'logicalToCoordinate', (...args: never[]) => unknown>>) {
  return {
    timeToCoordinate: () => null,
    timeToIndex: () => null,
    logicalToCoordinate: () => null,
    ...overrides,
  } as unknown as ITimeScaleApi<Time>;
}

describe('dockedLabelTimeToX', () => {
  it('timeToCoordinate가 좌표를 주면 픽셀비만 곱해 그대로 쓴다', () => {
    const toX = dockedLabelTimeToX(timeScaleStub({ timeToCoordinate: () => 123 }), 2);
    expect(toX(1000 as Time)).toBe(246);
  });

  it('범위 밖 시각(null)은 가장 가까운 봉으로 클램프한다 — 통합(UN) 확장 세션 close(20:00)가 마지막 봉 밖이면 당일 최대벽 라벨만 사라지던 결함', () => {
    const calls: unknown[][] = [];
    const toX = dockedLabelTimeToX(
      timeScaleStub({
        timeToCoordinate: () => null,
        timeToIndex: (...args: never[]) => {
          calls.push(args);
          return 42;
        },
        logicalToCoordinate: () => 650,
      }),
      2,
    );
    expect(toX(1000 as Time)).toBe(1300);
    // findNearest=true 로 가장 가까운 봉을 찾아야 한다(정확 일치 요구 금지).
    expect(calls[0]?.[1]).toBe(true);
  });

  it('가장 가까운 봉조차 없으면(빈 차트) null — 라벨 skip 동작 유지', () => {
    const toX = dockedLabelTimeToX(timeScaleStub({}), 2);
    expect(toX(1000 as Time)).toBeNull();
  });
});
