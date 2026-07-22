import { describe, expect, it } from 'vitest';
import type { ITimeScaleApi, Time } from 'lightweight-charts';
import {
  xCoordinateOrNearest,
  layoutAskPeakLabels,
  inlinePeakWallSegmentsForDocking,
  livePeakWallDockedLabelsFromSegments,
  peakLabelBudgetForBarSpacing,
  PEAK_LABEL_HIDE_BAR_SPACING_PX,
  PEAK_LABEL_BUDGET_MAX,
  PEAK_LABEL_BUDGET_MIN,
  visibleAskPeakLabelCandidates,
  type AskPeakLabelCandidate,
  type AskPeakSegment,
} from './AskPeakSegmentsPrimitive';

const candidate = (
  index: number,
  xRight: number,
  yLine: number,
  width = 70,
  segmentWidth = 120,
): AskPeakLabelCandidate => ({
  index,
  xRight,
  yLine,
  width,
  segmentWidth,
});

describe('layoutAskPeakLabels', () => {
  it('separates overlapping labels that share the same right edge', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 500, 100),
      candidate(1, 500, 104),
      candidate(2, 500, 108),
    ], 15, 220, 13);

    expect(out.map((l) => l.baselineY)).toEqual([100, 113, 126]);
  });

  it('uses the requested row height as the readable gap between close labels', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 500, 100),
      candidate(1, 500, 108),
      candidate(2, 500, 116),
    ], 15, 220, 16);

    expect(out.map((l) => l.baselineY)).toEqual([100, 116, 132]);
  });

  it('leaves nearby y labels alone when their text boxes do not overlap horizontally', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 150, 100),
      candidate(1, 500, 104),
    ], 15, 220, 13);

    expect(out.map((l) => l.baselineY)).toEqual([100, 104]);
  });

  it('keeps stacked labels inside the pane near the bottom edge', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 500, 202),
      candidate(1, 500, 206),
      candidate(2, 500, 210),
    ], 15, 220, 13);

    expect(out.map((l) => l.baselineY)).toEqual([194, 207, 220]);
  });
});

describe('visibleAskPeakLabelCandidates', () => {
  it('hides labels when zoomed out so the segment cannot fit the label', () => {
    const out = visibleAskPeakLabelCandidates([
      candidate(0, 500, 100, 70, 120),
      candidate(1, 540, 104, 70, 60),
    ], 8);

    expect(out.map((l) => l.index)).toEqual([0]);
  });
});

describe('peakLabelBudgetForBarSpacing', () => {
  it('hides all labels when zoomed out below the floor', () => {
    expect(peakLabelBudgetForBarSpacing(PEAK_LABEL_HIDE_BAR_SPACING_PX - 0.5)).toBe(0);
    expect(peakLabelBudgetForBarSpacing(0)).toBe(0);
    expect(peakLabelBudgetForBarSpacing(NaN)).toBe(0);
  });

  it('ramps from MIN at the floor to MAX when zoomed in', () => {
    expect(peakLabelBudgetForBarSpacing(PEAK_LABEL_HIDE_BAR_SPACING_PX)).toBe(PEAK_LABEL_BUDGET_MIN);
    expect(peakLabelBudgetForBarSpacing(1000)).toBe(PEAK_LABEL_BUDGET_MAX);
  });

  it('grows monotonically with bar spacing', () => {
    const near = peakLabelBudgetForBarSpacing(6);
    const wide = peakLabelBudgetForBarSpacing(12);
    expect(wide).toBeGreaterThanOrEqual(near);
    expect(near).toBeGreaterThanOrEqual(PEAK_LABEL_BUDGET_MIN);
    expect(wide).toBeLessThanOrEqual(PEAK_LABEL_BUDGET_MAX);
  });
});

const segment = (overrides: Partial<AskPeakSegment> = {}): AskPeakSegment => ({
  time0: 1 as never,
  time1: 2 as never,
  peakTime: 1.5 as never,
  price: 23500,
  qty: 17200,
  label: '23,500, 17.2k',
  color: '#f97316',
  lineWidth: 2,
  live: false,
  ...overrides,
});

describe('live peak-wall docked label helpers', () => {
  it('extracts labels from historical segments that overlap the visible range', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, label: '24,500, 16.6k', price: 24500 }),
        segment({ live: false, time0: 250 as never, time1: 300 as never, label: '23,500, 17.2k', price: 23500 }),
      ],
      { from: 150 as never, to: 220 as never },
    );

    expect(out).toEqual([
      { price: 24500, label: '24,500, 16.6k', color: '#f97316', time1: 200 },
    ]);
  });

  it('limits docked labels to the top visible qty ranks when requested', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 100, label: '100, 0.1k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 101, qty: 300, label: '101, 0.3k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 102, qty: 200, label: '102, 0.2k' }),
      ],
      { from: 100 as never, to: 200 as never },
      2,
    );

    expect(out.map((label) => label.price)).toEqual([101, 102]);
  });

  it('emits no docked labels when the zoom budget is zero', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, price: 100, qty: 300, label: '0.3k' }),
        segment({ live: false, price: 101, qty: 200, label: '0.2k' }),
      ],
      { from: 0 as never, to: 400 as never },
      0,
    );
    expect(out).toEqual([]);
  });

  it('keeps only the top-N walls by qty when a positive budget caps them', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, price: 100, qty: 100, label: '0.1k' }),
        segment({ live: false, price: 101, qty: 300, label: '0.3k' }),
        segment({ live: false, price: 102, qty: 200, label: '0.2k' }),
      ],
      { from: 0 as never, to: 400 as never },
      2,
    );
    expect(out.map((l) => l.price).sort((a, b) => a - b)).toEqual([101, 102]);
  });

  it('treats same-price docked-label candidates as one visible wall rank', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 300, label: '100, 0.3k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 250, label: '100, 0.25k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 101, qty: 200, label: '101, 0.2k' }),
      ],
      { from: 100 as never, to: 200 as never },
      2,
    );

    expect(out.map((label) => [label.price, label.label])).toEqual([
      [100, '100, 0.3k'],
      [101, '101, 0.2k'],
    ]);
  });

  it('keeps the largest same-price label when labels are uncapped', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 250, label: '100, 0.25k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 300, label: '100, 0.3k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 101, qty: 200, label: '101, 0.2k' }),
      ],
      { from: 100 as never, to: 200 as never },
    );

    expect(out.map((label) => [label.price, label.label])).toEqual([
      [100, '100, 0.3k'],
      [101, '101, 0.2k'],
    ]);
  });

  it('extracts labels only from live segments with visible label text', () => {
    const out = livePeakWallDockedLabelsFromSegments([
      segment({ live: false, label: '24,500, 16.6k', price: 24500, color: '#f97316' }),
      segment({ live: true, label: '23,500, 17.2k', price: 23500, color: '#ec4899' }),
      segment({ live: true, label: '', price: 23000, color: '#60a5fa' }),
    ]);

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#ec4899', time1: 2 },
    ]);
  });

  it('keeps live docked labels whose segment overlaps the visible range', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [segment({ live: true, time0: 100 as never, time1: 200 as never })],
      { from: 150 as never, to: 250 as never },
    );

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#f97316', time1: 200 },
    ]);
  });

  it('hides live docked labels whose segment is outside the visible range', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [segment({ live: true, time0: 100 as never, time1: 200 as never })],
      { from: 10 as never, to: 90 as never },
    );

    expect(out).toEqual([]);
  });

  it('keeps current behavior when the visible range is unavailable', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [segment({ live: true, time0: 100 as never, time1: 200 as never })],
      null,
    );

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#f97316', time1: 200 },
    ]);
  });

  it('removes inline label text while preserving segment geometry for docked labels', () => {
    const past = segment({ live: false, label: '24,500, 16.6k', price: 24500 });
    const live = segment({ live: true, label: '23,500, 17.2k', price: 23500 });
    const out = inlinePeakWallSegmentsForDocking([past, live]);

    expect(out[0]).toEqual({ ...past, label: '' });
    expect(out[1]).toEqual({ ...live, label: '' });
    expect(out[0]).toMatchObject({
      time0: past.time0,
      time1: past.time1,
      peakTime: past.peakTime,
      price: past.price,
      qty: past.qty,
      color: past.color,
      lineWidth: past.lineWidth,
      live: false,
    });
    expect(out[1]).toMatchObject({
      time0: live.time0,
      time1: live.time1,
      peakTime: live.peakTime,
      price: live.price,
      qty: live.qty,
      color: live.color,
      lineWidth: live.lineWidth,
      live: true,
    });
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

describe('xCoordinateOrNearest', () => {
  it('timeToCoordinate가 좌표를 주면 그대로 쓴다', () => {
    const ts = timeScaleStub({ timeToCoordinate: () => 123 });
    expect(xCoordinateOrNearest(ts, 1000 as Time)).toBe(123);
  });

  it('범위 밖 시각(null)은 가장 가까운 봉 인덱스로 클램프한다 — 통합 확장 세션 경계에서 그날 벽 선이 통째로 사라지던 결함', () => {
    const calls: unknown[][] = [];
    const ts = timeScaleStub({
      timeToCoordinate: () => null,
      timeToIndex: (...args: never[]) => {
        calls.push(args);
        return 42;
      },
      logicalToCoordinate: () => 777,
    });
    expect(xCoordinateOrNearest(ts, 1000 as Time)).toBe(777);
    // findNearest=true 로 가장 가까운 봉을 찾아야 한다(정확 일치 요구 금지).
    expect(calls[0]?.[1]).toBe(true);
  });

  it('가장 가까운 봉조차 없으면(빈 차트) null — 기존 skip 동작 유지', () => {
    const ts = timeScaleStub({});
    expect(xCoordinateOrNearest(ts, 1000 as Time)).toBeNull();
  });
});
