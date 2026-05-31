import { describe, it, expect } from 'vitest';
import {
  nextHistoricalFrom,
  realMsToYyyymmdd,
  subtractDaysKst,
  prefetchChunkDaysFor,
} from './liveDateTime';
import { unixMsToKSTDate } from '../util/time';

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

describe('realMsToYyyymmdd', () => {
  // Single-source invariant (fe-shared-02): realMsToYyyymmdd is a /live-local
  // alias that delegates to util/time::unixMsToKSTDate — the one owner of the
  // "Unix-ms → YYYYMMDD KST" calendar-day rule. These pin the boundary (which
  // had no direct coverage) and lock the delegation so a future edit can't
  // quietly reintroduce a divergent +9h copy.
  it('returns the KST calendar day at session open (09:00 KST = 00:00 UTC)', () => {
    expect(realMsToYyyymmdd(Date.UTC(2026, 4, 20, 0, 0, 0))).toBe('20260520');
  });

  it('uses the KST calendar boundary (UTC 15:00 of day N-1 = KST 00:00 of day N)', () => {
    const kstMidnight = Date.UTC(2026, 4, 19, 15, 0, 0);
    expect(realMsToYyyymmdd(kstMidnight - 1)).toBe('20260519');
    expect(realMsToYyyymmdd(kstMidnight)).toBe('20260520');
  });

  it('agrees with the single source unixMsToKSTDate across 48h of samples', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let h = 0; h < 48; h += 1) {
      const ms = base + h * 3_600_000;
      expect(realMsToYyyymmdd(ms)).toBe(unixMsToKSTDate(ms));
    }
  });
});
