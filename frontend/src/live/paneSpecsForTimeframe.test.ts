import { describe, it, expect } from 'vitest';
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';
import { PANE_SPECS } from '../chart/paneSpecs';
import { CANDLE_SPEC } from '../chart/projectors/candle';
import { VOLUME_SPEC } from '../chart/projectors/volume';

describe('paneSpecsForTimeframe', () => {
  it.each(['1m', '3m', '5m', '10m', '15m', '30m'] as const)(
    'minute timeframe %s → full 5-pane registry (PANE_SPECS identity)',
    (tf) => {
      expect(paneSpecsForTimeframe(tf)).toBe(PANE_SPECS);
    },
  );

  it.each(['D', 'W', 'M'] as const)(
    'calendar timeframe %s → only candle + volume',
    (tf) => {
      const result = paneSpecsForTimeframe(tf);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(CANDLE_SPEC);
      expect(result[1]).toBe(VOLUME_SPEC);
    },
  );

  it('minute timeframes share the SAME array reference (memoization)', () => {
    expect(paneSpecsForTimeframe('1m')).toBe(paneSpecsForTimeframe('5m'));
  });

  it('calendar timeframes share the SAME array reference (memoization)', () => {
    expect(paneSpecsForTimeframe('D')).toBe(paneSpecsForTimeframe('W'));
  });
});
