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

  it('minute timeframes ignore investor toggles entirely', () => {
    expect(paneSpecsForTimeframe('1m', { foreignNet: true, institutionNet: true })).toBe(PANE_SPECS);
  });

  it('D + foreign toggle appends the foreign pane', () => {
    expect(paneSpecsForTimeframe('D', { foreignNet: true, institutionNet: false }).map((s) => s.name))
      .toEqual(['candle', 'volume', 'investor-foreign']);
  });

  it('D + institution toggle appends the institution pane in the correct slot', () => {
    // Spec-level self-heal: institution alone still lands right after volume,
    // because paneSpecsForTimeframe always emits canonical order (no hole left
    // by the absent foreign pane).
    expect(paneSpecsForTimeframe('D', { foreignNet: false, institutionNet: true }).map((s) => s.name))
      .toEqual(['candle', 'volume', 'investor-institution']);
  });

  it('D + both toggles appends foreign THEN institution (canonical order)', () => {
    expect(paneSpecsForTimeframe('D', { foreignNet: true, institutionNet: true }).map((s) => s.name))
      .toEqual(['candle', 'volume', 'investor-foreign', 'investor-institution']);
  });

  it('W and M never get investor panes even with toggles on (daily-only)', () => {
    for (const tf of ['W', 'M'] as const) {
      expect(paneSpecsForTimeframe(tf, { foreignNet: true, institutionNet: true }).map((s) => s.name))
        .toEqual(['candle', 'volume']);
    }
  });
});
