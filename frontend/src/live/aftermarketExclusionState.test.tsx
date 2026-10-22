import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { AftermarketExclusionResponse } from '../api/aftermarketExclusion';
import { aftermarketExclusionState as state } from './aftermarketExclusionState';
import { BookAvailabilityState } from './workspace/BookAvailabilityState';

const now = Date.parse('2026-10-22T19:30:00+09:00');
const bookMs = Date.parse('2026-10-22T15:30:02+09:00');
const response: AftermarketExclusionResponse = { code: '079650', date: '20261022', status: 'checked',
  reasons: ['investment_warning'], checked_at_ms: now, source: 'kiwoom_ka10100' };
afterEach(cleanup);

it.each([
  ['etf', 'ETF'], ['etn', 'ETN'], ['investment_warning', '투자경고종목'],
  ['investment_risk', '투자위험종목'], ['administrative', '관리종목'], ['liquidation', '정리매매종목'],
  ['short_term_overheat', '단기과열종목'], ['investment_caution_issue', '투자주의환기종목'],
  ['low_liquidity', '초저유동종목'], ['abnormal_surge', '이상급등종목'], ['investment_caution', '투자유의종목'],
] as const)('explains confirmed %s without a connection action', (reason, label) => {
  const result = state({ ...response, reasons: [reason] }, '079650', 'KRX', now, bookMs);
  expect(result).toMatchObject({ kind: 'aftermarket_excluded', message: `KRX 장후 거래 제외 · ${label}`, lastBookMs: bookMs });
  render(<BookAvailabilityState state={result} onRetry={() => { throw new Error('should not retry'); }} />);
  expect(screen.getByTestId('book-availability')).toHaveTextContent('16:00~20:00');
  expect(screen.getByTestId('book-availability')).toHaveTextContent('마지막 호가 · 15:30:02');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByText('호가 수신 지연')).not.toBeInTheDocument();
});

it('keeps multiple confirmed reasons and handles an absent retained book', () => {
  expect(state({ ...response, reasons: ['administrative', 'investment_caution_issue'] }, '079650', 'KRX', now))
    .toEqual({ kind: 'aftermarket_excluded', message: 'KRX 장후 거래 제외 · 관리종목 · 투자주의환기종목',
      detail: '16:00~20:00 KRX 애프터마켓 거래 대상이 아닙니다.' });
});

it('does not borrow restrictions across subject, market, date, time or freshness', () => {
  expect(state(response, '005930', 'KRX', now)).toBeNull();
  expect(state(response, '079650', 'UN', now)).toBeNull();
  expect(state(response, '079650', 'NXT', now)).toBeNull();
  expect(state(response, '079650', 'KRX', now + 120_000)).toBeNull();
  expect(state(response, '079650', 'KRX', now - 6_000)).toBeNull();
  expect(state({ ...response, checked_at_ms: now + 86_400_000 }, '079650', 'KRX', now + 86_400_000)).toBeNull();
  expect(state({ ...response, checked_at_ms: now + 30 * 60_000 }, '079650', 'KRX', now + 30 * 60_000)).toBeNull();
  expect(state({ ...response, checked_at_ms: now - 4 * 3_600_000 }, '079650', 'KRX', now - 4 * 3_600_000)).toBeNull();
});

it.each(['error', 'unavailable', 'inactive'] as const)('does not use a %s result to assert exclusion', status => {
  expect(state({ ...response, status }, '079650', 'KRX', now)).toBeNull();
});

it('does not interpret an empty lookup as either exclusion or permission to trade', () => {
  expect(state({ ...response, reasons: [] }, '079650', 'KRX', now)).toBeNull();
});
