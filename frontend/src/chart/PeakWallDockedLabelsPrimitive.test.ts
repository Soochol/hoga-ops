import { describe, expect, it } from 'vitest';
import {
  peakWallDockedLabelCandidates,
  type PeakWallDockedLabelInput,
} from './PeakWallDockedLabelsPrimitive';

describe('peakWallDockedLabelCandidates', () => {
  const labels: PeakWallDockedLabelInput[] = [
    { price: 24500, label: '24,500, 16.6k', color: '#f97316' },
    { price: 23500, label: '23,500, 17.2k', color: '#ec4899' },
    { price: 23000, label: '', color: '#60a5fa' },
  ];

  it('pins all visible labels to the shared right-side lane', () => {
    const out = peakWallDockedLabelCandidates(
      labels,
      (price) => (price === 24500 ? 100 : price === 23500 ? 104 : 108),
      780,
      (text) => text.length * 5,
    );

    expect(out).toEqual([
      { index: 0, xRight: 780, yLine: 97, width: '24,500, 16.6k'.length * 5, segmentWidth: Number.POSITIVE_INFINITY },
      { index: 1, xRight: 780, yLine: 101, width: '23,500, 17.2k'.length * 5, segmentWidth: Number.POSITIVE_INFINITY },
    ]);
  });

  it('skips labels whose price is not mappable to a y coordinate', () => {
    const out = peakWallDockedLabelCandidates(
      labels,
      (price) => (price === 24500 ? 100 : null),
      780,
      (text) => text.length,
    );

    expect(out.map((candidate) => candidate.index)).toEqual([0]);
  });
});
