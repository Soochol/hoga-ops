import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { VolumeParams } from '../api/screener';
import { screenerRequestKey } from '../api/screenerRequest';
import { HistoryVolumeForm } from './HistoryVolumeForm';
import { CONDITION_CATALOG } from './catalog';

const choice = (label: string, name: string) => within(screen.getByRole('group', { name: label })).getByRole('button', { name });
const timeframeNames: Record<string, string> = { minute: '분', D: '일', W: '주', M: '월' };

function Editor({ initial = { lookback: 60, period: 250 } }: { initial?: VolumeParams }) {
  const [params, setParams] = useState(initial);
  return <><HistoryVolumeForm params={params} onChange={setParams} /><output>{JSON.stringify(params)}</output></>;
}

it('changes minute/day/week/month without changing the candle counts', () => {
  render(<Editor />);
  expect(choice('거래량 주기', '일')).toHaveAttribute('aria-pressed', 'true');
  for (const timeframe of ['W', 'M', 'minute', 'D']) {
    fireEvent.click(choice('거래량 주기', timeframeNames[timeframe]));
    expect(screen.getByLabelText('최근 기간(봉)')).toHaveValue(60);
    expect(screen.getByLabelText('신고 기준 기간(봉)')).toHaveValue(250);
    if (timeframe === 'minute') {
      fireEvent.change(screen.getByLabelText('분봉 간격'), { target: { value: '3m' } });
      expect(screen.getByRole('status')).toHaveTextContent('"timeframe":"3m"');
    }
  }
  expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
});

it('preserves date bounds when converting old daily history to candle counts', () => {
  render(<Editor initial={{ mode: 'date_range', start_date: '2019-01-01', end_date: '2022-12-31',
    record_period: { unit: 'years', value: 2 } }} />);
  fireEvent.click(choice('거래량 주기', '월'));
  expect(screen.getByLabelText('거래량 발생 시작일')).toHaveValue('2019-01-01');
  expect(screen.getByRole('status')).toHaveTextContent('"unit":"bars"');
  expect(screen.getByLabelText('거래량 비교 기간')).toHaveValue(250);
});

describe('saved conditions', () => {
  it('normalizes old daily defaults and preserves distinct periods', () => {
    const request = (params: VolumeParams) => ({ conditions: [{ id: 'v', type: 'new_high_vol' as const, params }], universe: {} });
    const old = request({ lookback: 60, period: 250 });
    expect(screenerRequestKey(old)).toBe(screenerRequestKey(request({ lookback: 60, period: 250,
      timeframe: 'D', include_open_bar: true })));
    expect(screenerRequestKey(old)).not.toBe(screenerRequestKey(request({ lookback: 60, period: 250, timeframe: 'W' })));
    expect(CONDITION_CATALOG.new_high_vol.summarize({ lookback: 60, period: 250, timeframe: '5m' })).toBe('5분봉 · 60·250');
  });
});

it('keeps the open-bar policy and comparison count when switching the search window', () => {
  render(<Editor initial={{ lookback: 3, period: 12, timeframe: '5m', include_open_bar: true }} />);
  fireEvent.click(choice('거래량 검색 기간', '날짜 범위'));
  expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('"include_open_bar":true');
  expect(screen.getByLabelText('거래량 비교 기간')).toHaveValue(12);
  fireEvent.click(choice('거래량 검색 기간', '최근 N봉'));
  expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('"include_open_bar":true');
  expect(screen.getByLabelText('신고 기준 기간(봉)')).toHaveValue(12);
});
