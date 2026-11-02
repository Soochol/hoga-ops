import { afterEach, expect, it, vi } from 'vitest';
import type { BarVolumeCoverage } from '../api/screener';
import { minuteHistoryDetail, minuteHistoryState } from './minuteHistoryState';
import { emptyResultText } from './emptyResultText';

const coverage: BarVolumeCoverage = { total: 2, complete: 0, trading_date: '2026-11-02',
  incomplete: ['3m', '5m', '10m'].map(condition_id => ({ code: '005930', condition_id, reason: 'insufficient_minute_history' })) };
const requestJson = JSON.stringify({ conditions: [['3m', 40], ['5m', 24], ['10m', 12]].map(([timeframe, period]) => ({
  id: timeframe, type: 'new_high_vol', params: { timeframe, period, lookback: 3 },
})) });
afterEach(() => vi.useRealTimers());

it('explains the actual afternoon comparison counts during the current regular session', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T09:27:00+09:00'));
  expect(minuteHistoryState(coverage)).toBe('당일 분봉이 더 쌓여야 평가할 수 있습니다');
  expect(minuteHistoryDetail({ barCoverage: coverage, requestJson }))
    .toBe('필요한 비교 자료: 3분봉 42개 · 5분봉 26개 · 10분봉 14개. 해당 거래일 하루의 자료만 사용합니다.');
});

it('does not promise that completed historical sessions will gain more bars', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T01:00:00+09:00'));
  expect(minuteHistoryState(coverage)).toBe('선택 거래일의 비교 분봉이 부족합니다');
});

it('keeps partial evaluation and transport errors distinct from waiting for bars', () => {
  expect(minuteHistoryState({ ...coverage, complete: 1 })).toBeNull();
  expect(minuteHistoryState({ ...coverage, incomplete: [...coverage.incomplete,
    { code: '000660', condition_id: '3m', reason: 'fetch_timeout' }] })).toBeNull();
  expect(minuteHistoryDetail({ barCoverage: coverage, requestJson: '{broken' })).toBeNull();
});

it('shows preparation before the background seed has arrived', () => {
  expect(emptyResultText({ warnings: [], barCoverage: { ...coverage, incomplete: [
    { code: '005930', condition_id: '3m', reason: 'volume_preparing' }],
    realtime: { continuous: true, prepared: 0, preparing: 2, receiving: 0 } } }))
    .toBe('분봉 자료를 준비하고 있습니다');
});
