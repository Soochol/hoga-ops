import { describe, expect, it } from 'vitest';
import { regularSessionOpenMs as open, regularSessionCloseMs as close } from '../liveDateTime';
import { majorIndicesTimeAxis } from './majorIndicesTimeAxis';

const date = '20261015';
const minute = 60_000;
describe('major indices time axis', () => {
  it('fills the plot from 09:00 to the current minute during trading', () => {
    const now = open(date) + 100 * minute;
    const axis = majorIndicesTimeAxis(date, now, 600);
    expect(axis.start).toBe(open(date));
    expect(axis.end).toBe(now);
    expect(axis.ticks.map(time => (time - axis.start) / minute)).toEqual([0, 15, 30, 45, 60, 75, 100]);
  });
  it('uses 30-minute and hourly ticks as the displayed range grows or the window narrows', () => {
    expect(majorIndicesTimeAxis(date, open(date) + 180 * minute, 500).ticks.map(t => (t - open(date)) / minute))
      .toEqual([0, 30, 60, 90, 120, 150, 180]);
    expect(majorIndicesTimeAxis(date, close(date), 500).ticks.map(t => (t - open(date)) / minute))
      .toEqual([0, 60, 120, 180, 240, 300, 390]);
  });
  it('keeps the full selected session after close and on a later premarket day', () => {
    for (const now of [close(date), close(date) + minute, open('20261016') - minute]) {
      expect(majorIndicesTimeAxis(date, now, 500).end).toBe(close(date));
    }
  });
  it('has a single finite time at the open and before any current-day trading', () => {
    for (const now of [open(date) - minute, open(date)]) {
      expect(majorIndicesTimeAxis(date, now, 500)).toEqual({ start: open(date), end: open(date), ticks: [open(date)] });
    }
  });
  it('avoids colliding labels at narrow widths and enlarged font spacing', () => {
    for (const minutes of [1, 61, 100, 390]) for (const width of [40, 100, 200, 240, 600]) for (const spacing of [64, 100]) {
      const { start, end, ticks } = majorIndicesTimeAxis(date, open(date) + minutes * minute, width, spacing);
      expect(ticks.at(-1)).toBe(end);
      for (let i = 1; i < ticks.length; i++) {
        expect((ticks[i] - ticks[i - 1]) / (end - start) * width).toBeGreaterThanOrEqual(spacing);
      }
    }
  });
});
