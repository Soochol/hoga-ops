import { describe, it, expect } from 'vitest';
import {
  nextHistoricalFrom,
  realMsToYyyymmdd,
  subtractDaysKst,
  prefetchChunkDaysFor,
} from './liveDateTime';

/** SR-1/SR-3: the /live infinite-scroll backfill policy was fused inside
 * LiveChartRoot's subscribeVisibleLogicalRangeChange effect, testable only by
 * driving a chart mock. nextHistoricalFrom is the extracted pure kernel:
 * "given where the axis currently starts, what date should the next leftward
 * chunk fetch back to?" These cases pin the holiday-span / monotonic-decrease
 * rule directly. */
describe('nextHistoricalFrom', () => {
  // 2026-02-02 09:00 KST in Unix ms — axis earliest for the base cases.
  const axisEarliestMs = Date.UTC(2026, 1, 2, 0, 0, 0); // 09:00 KST == 00:00 UTC
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);

  it('steps back one prefetch chunk from the axis earliest when no fetch is in flight', () => {
    // historicalFromDate null → base off the axis earliest.
    const got = nextHistoricalFrom(axisEarliestMs, null, '1m');
    expect(got).toBe(subtractDaysKst(axisEarliestDate, prefetchChunkDaysFor('1m')));
  });

  it('bases off historicalFromDate when it is already earlier than the axis (holiday-span progress)', () => {
    // A prior chunk landed on a holiday-only span: the axis earliest did NOT
    // move, but historicalFromDate already stepped back. The next trigger must
    // keep stepping back from historicalFromDate, not re-request the axis date.
    const earlier = subtractDaysKst(axisEarliestDate, 40);
    const got = nextHistoricalFrom(axisEarliestMs, earlier, '1m');
    expect(got).toBe(subtractDaysKst(earlier, prefetchChunkDaysFor('1m')));
  });

  it('ignores a historicalFromDate that is NOT earlier than the axis earliest', () => {
    // Defensive: if the store somehow holds a date >= axis earliest, prefer the
    // axis so we never step forward.
    const later = subtractDaysKst(axisEarliestDate, -5); // 5 days AFTER axis earliest
    const got = nextHistoricalFrom(axisEarliestMs, later, '1m');
    expect(got).toBe(subtractDaysKst(axisEarliestDate, prefetchChunkDaysFor('1m')));
  });

  it('uses the timeframe-specific chunk size (D differs from 1m)', () => {
    const minute = nextHistoricalFrom(axisEarliestMs, null, '1m');
    const daily = nextHistoricalFrom(axisEarliestMs, null, 'D');
    expect(minute).toBe(subtractDaysKst(axisEarliestDate, prefetchChunkDaysFor('1m')));
    expect(daily).toBe(subtractDaysKst(axisEarliestDate, prefetchChunkDaysFor('D')));
    // The two chunk sizes differ, so the resulting dates differ.
    expect(prefetchChunkDaysFor('1m')).not.toBe(prefetchChunkDaysFor('D'));
    expect(minute).not.toBe(daily);
  });

  it('is monotonic: feeding its own output back always steps further back', () => {
    const first = nextHistoricalFrom(axisEarliestMs, null, '1m');
    const second = nextHistoricalFrom(axisEarliestMs, first, '1m');
    expect(second < first).toBe(true);
  });
});
