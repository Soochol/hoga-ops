import { describe, expect, it } from 'vitest';
import {
  peakWallDockedLabelCandidates,
  type PeakWallDockedLabelInput,
} from './PeakWallDockedLabelsPrimitive';
import type { Time } from 'lightweight-charts';

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
