import { describe, expect, it } from 'vitest';
import { chooseSnapshotWindow } from './snapshotWindow';

const bars = Array.from({ length: 300 }, (_, i) => ({ t: i }));

describe('chooseSnapshotWindow', () => {
  it('keeps visible range when it is wider than 200 bars', () => {
    expect(chooseSnapshotWindow(bars, 10, 250)).toEqual({ fromIndex: 10, toIndex: 250 });
  });

  it('expands a narrow range to 200 centered around visible range', () => {
    expect(chooseSnapshotWindow(bars, 100, 119)).toEqual({ fromIndex: 10, toIndex: 209 });
  });

  it('fills from the right when left edge lacks enough bars', () => {
    expect(chooseSnapshotWindow(bars, 0, 20)).toEqual({ fromIndex: 0, toIndex: 199 });
  });

  it('returns an empty window for empty input', () => {
    expect(chooseSnapshotWindow([], 0, 20)).toEqual({ fromIndex: 0, toIndex: -1 });
  });
});
