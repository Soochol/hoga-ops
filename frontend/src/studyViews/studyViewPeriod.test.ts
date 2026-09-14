import { expect, it, vi } from 'vitest';
import { studyViewPeriod, shortStudyDate, compactStudyViewName, compactStudyViewPeriod } from './studyViewPeriod';
it('distinguishes intraday ranges in KST and preserves both years across new year', () => {
  const range = { from_date: '20251231', to_date: '20260102', from_ms: Date.parse('2025-12-31T00:05:00Z'), to_ms: Date.parse('2026-01-02T06:20:00Z') };
  expect(studyViewPeriod(range, '5m')).toBe('2025-12-31 09:05:00–2026-01-02 15:20:00 KST');
  expect(studyViewPeriod(range, 'D')).toBe('2025-12-31–2026-01-02');
});

it('uses the end date for titles and keeps past years, with minute precision only in list metadata', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 14));
  try {
    expect(compactStudyViewName('삼성전자', '20260914')).toBe('삼성전자 · 09.14');
    expect(compactStudyViewName('삼성전자', '20250914')).toBe('삼성전자 · 25.09.14');
    expect(shortStudyDate('2026-09-14', 2027)).toBe('26.09.14');
    const range = { from_date: '20260914', to_date: '20260914', from_ms: Date.parse('2026-09-14T00:00:23Z'), to_ms: Date.parse('2026-09-14T01:30:59Z') };
    expect(compactStudyViewPeriod(range, '1m')).toBe('09.14 09:00–10:30');
    expect(studyViewPeriod(range, '1m')).toBe('2026-09-14 09:00:23–10:30:59 KST');
  } finally { vi.restoreAllMocks(); }
});
