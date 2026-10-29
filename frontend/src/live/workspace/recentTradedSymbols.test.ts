import { expect, it } from 'vitest';
import type { ExecutionHistoryRow } from '../../api/executionHistory';
import { recentTradedSymbols, recentTradedSymbolsForRange } from './recentTradedSymbols';

const row = (code: string, filled_at: string | null, extra: Partial<ExecutionHistoryRow> = {}): ExecutionHistoryRow => ({
  order_ref: code, broker_order_id: code, code, name: null, side: 'BUY', quantity: '10', order_quantity: '10',
  price: '50000', price_basis: 'execution', amount: null, route: 'KRX', filled_at,
  ordered_at: '2026-10-29T23:00:00+09:00', ...extra,
});

it('deduplicates across the full year by actual trading date, even if newer fills omit their clock', () => {
  const result = recentTradedSymbolsForRange([
    { ...row('005930', '2025-11-01T09:10:00+09:00', { name: '삼성전자' }), date: '20251101' },
    { ...row('005930', null), date: '20261028' },
    { ...row('000660', null), date: '20261029' },
    { ...row('0099A0', null), date: '20251029' },
    { ...row('035720', null), date: '20251028' },
    { ...row('035420', null), date: '20261030' },
  ], '20251029', '20261029');
  expect(result.map(({ code, date, filledAt }) => ({ code, date, filledAt }))).toEqual([
    { code: '000660', date: '20261029', filledAt: null },
    { code: '005930', date: '20261028', filledAt: null },
    { code: '0099A0', date: '20251029', filledAt: null },
  ]);
  expect(result[1].name).toBe('삼성전자');
});

it('deduplicates stocks at the latest actual fill, retaining a provided name and sorting newest first', () => {
  const result = recentTradedSymbols([
    row('005930', '2026-10-29T09:10:00+09:00', { name: '삼성전자' }),
    row('000660', '2026-10-29T09:20:00+09:00'),
    row('005930', '2026-10-29T00:30:00Z'),
    row('005930', '2026-10-29T09:05:00+09:00'),
    row('005930', null),
  ], '20261029');
  expect(result).toEqual([
    { code: '005930', name: '삼성전자', filledAt: Date.parse('2026-10-29T09:30:00+09:00') },
    { code: '000660', name: null, filledAt: Date.parse('2026-10-29T09:20:00+09:00') },
  ]);
});

it('keeps missing fill times blank and last; never uses order time; accepts leading zeros and alphanumeric codes', () => {
  expect(recentTradedSymbols([
    row('005930', null), row('000660', 'invalid'), row('0099A0', '2026-10-29T08:00:00+09:00'),
    row('bad', null), row('005930', null, { quantity: '0' }),
    row('035720', null, { quantity: 'Infinity' }), row('035420', null, { quantity: '-1' }),
    row('123456', '2026-10-28T23:59:59+09:00'), row('654321', '2026-10-30T00:00:00+09:00'),
  ], '20261029')).toEqual([
    { code: '0099A0', name: null, filledAt: Date.parse('2026-10-29T08:00:00+09:00') },
    { code: '000660', name: null, filledAt: null }, { code: '005930', name: null, filledAt: null },
  ]);
});
