import { expect, it } from 'vitest';
import { studyViewPeriod } from './studyViewPeriod';
it('distinguishes intraday ranges in KST and preserves both years across new year', () => {
  const range = { from_date: '20251231', to_date: '20260102', from_ms: Date.parse('2025-12-31T00:05:00Z'), to_ms: Date.parse('2026-01-02T06:20:00Z') };
  expect(studyViewPeriod(range, '5m')).toBe('2025-12-31 09:05:00–2026-01-02 15:20:00 KST');
  expect(studyViewPeriod(range, 'D')).toBe('2025-12-31–2026-01-02');
});
