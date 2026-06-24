import { describe, expect, it } from 'vitest';
import {
  layoutAskPeakLabels,
  visibleAskPeakLabelCandidates,
  type AskPeakLabelCandidate,
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
