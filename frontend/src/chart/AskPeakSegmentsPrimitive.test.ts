import { describe, expect, it } from 'vitest';
import {
  layoutAskPeakLabels,
  inlinePeakWallSegmentsForDocking,
  livePeakWallDockedLabelsFromSegments,
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
  it('extracts labels only from live segments with visible label text', () => {
    const out = livePeakWallDockedLabelsFromSegments([
      segment({ live: false, label: '24,500, 16.6k', price: 24500, color: '#f97316' }),
      segment({ live: true, label: '23,500, 17.2k', price: 23500, color: '#ec4899' }),
      segment({ live: true, label: '', price: 23000, color: '#60a5fa' }),
    ]);

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#ec4899' },
    ]);
  });

  it('keeps live docked labels whose segment overlaps the visible range', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [segment({ live: true, time0: 100 as never, time1: 200 as never })],
      { from: 150 as never, to: 250 as never },
    );

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#f97316' },
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
      { price: 23500, label: '23,500, 17.2k', color: '#f97316' },
    ]);
  });

  it('removes only live inline label text while preserving historical labels and geometry', () => {
    const past = segment({ live: false, label: '24,500, 16.6k', price: 24500 });
    const live = segment({ live: true, label: '23,500, 17.2k', price: 23500 });
    const out = inlinePeakWallSegmentsForDocking([past, live]);

    expect(out[0]).toEqual(past);
    expect(out[1]).toEqual({ ...live, label: '' });
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
