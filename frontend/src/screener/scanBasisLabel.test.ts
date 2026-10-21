import { expect, it } from 'vitest';
import { scanBasisLabel } from './scanBasisLabel';

it('uses server cutoffs in KST, including empty results and mixed dates', () => {
  const confirmed = Date.UTC(2026, 9, 19, 6, 30);
  const live = Date.UTC(2026, 9, 20, 1, 35);
  expect(scanBasisLabel({ rows: [], basisAtMs: confirmed })).toBe('2026-10-19 15:30 기준');
  expect(scanBasisLabel({ rows: [], basisAtMs: live, fallbackBasisAtMs: confirmed }))
    .toBe('10:35 기준 · 일부 종목 전일 데이터');
  expect(scanBasisLabel({ rows: [], basisAtMs: live, fallbackBasisAtMs: live })).toBe('2026-10-20 10:35 기준');
});

it('does not invent a time for legacy snapshots or unknown metadata', () => {
  expect(scanBasisLabel({ rows: [] })).toBe('기준 정보 없음');
  const row = { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 100,
    trade_value_won: 100, change_pct: null, price_date: '2026-10-19' };
  expect(scanBasisLabel({ rows: [row], basisAtMs: null })).toBe('2026-10-19 기준');
});
