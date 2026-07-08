import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  formatAggregationTime,
  formatQtyCompact,
  InvestorTrendEstimateCard,
} from './InvestorTrendEstimateCard';
import type { LiveInvestorTrendEstimateResponse } from '../api/liveInvestorTrendEstimate';

const rows: LiveInvestorTrendEstimateResponse['rows'] = [
  {
    slot: '1',
    observed_at_ms: new Date('2026-06-16T00:20:00Z').getTime(),
    foreign_qty: 1500,
    institution_qty: -200,
    sum_qty: 1300,
  },
  {
    slot: '2',
    observed_at_ms: new Date('2026-06-16T00:30:00Z').getTime(),
    foreign_qty: null,
    institution_qty: 0,
    sum_qty: 0,
  },
];

function response(
  overrides: Partial<LiveInvestorTrendEstimateResponse> = {},
): LiveInvestorTrendEstimateResponse {
  return {
    code: '005930',
    trading_day: '20260616',
    fetched_at_ms: new Date('2026-06-16T00:15:00Z').getTime(),
    rows,
    latest: rows[1],
    source: 'kis',
    status: 'ok',
    data_warning: null,
    ...overrides,
  };
}

describe('formatQtyCompact', () => {
  it('abbreviates ≥1만 quantities to 만 units so the 3 columns fit', () => {
    expect(formatQtyCompact(-4_361_000)).toBe('-436만');
    expect(formatQtyCompact(-620_000)).toBe('-62만');
    expect(formatQtyCompact(265_000)).toBe('+26.5만');
    expect(formatQtyCompact(1_146_000)).toBe('+115만'); // ≥100만 → 0 digits
  });

  it('keeps sub-1만 quantities as raw signed comma values', () => {
    expect(formatQtyCompact(1500)).toBe('+1,500');
    expect(formatQtyCompact(-200)).toBe('-200');
  });

  it('handles zero and null', () => {
    expect(formatQtyCompact(0)).toBe('0');
    expect(formatQtyCompact(null)).toBe('-');
  });
});

describe('formatAggregationTime', () => {
  it('renders the actual observed HH:MM with the aggregation round', () => {
    expect(formatAggregationTime(rows[0], 0)).toBe('1차(09:20)');
    expect(formatAggregationTime({
      slot: '0910',
      observed_at_ms: new Date('2026-06-16T00:40:00Z').getTime(),
    }, 1)).toBe('2차(09:40)');
    expect(formatAggregationTime({ slot: '0920' }, 0)).toBe('09:20');
  });
});

describe('InvestorTrendEstimateCard', () => {
  it('renders title, all rows, latest marker, fetched time, and footer', () => {
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    expect(screen.getByTestId('investor-trend-estimate-card')).toBeInTheDocument();
    expect(screen.getByText('외인·기관 추정')).toBeInTheDocument();
    expect(screen.getByText('집계시간')).toBeInTheDocument();
    expect(screen.getByText('외국인')).toBeInTheDocument();
    expect(screen.getByText('기관')).toBeInTheDocument();
    expect(screen.getByText('합산')).toBeInTheDocument();
    expect(screen.getByText('1차(09:20)')).toBeInTheDocument();
    expect(screen.getByText('2차(09:30)')).toBeInTheDocument();
    expect(screen.getByText('+1,500')).toBeInTheDocument();
    expect(screen.getByText('-200')).toBeInTheDocument();
    expect(screen.getByText('KIS 장중 가집계 · 수량 기준')).toBeInTheDocument();
    expect(screen.getByText('최근 조회 09:15')).toBeInTheDocument();

    const latest = screen.getByTestId('investor-estimate-row-latest');
    expect(within(latest).getByText('2차(09:30)')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('keeps rows visible and shows delayed state when an error response has rows', () => {
    render(
      <InvestorTrendEstimateCard
        query={{
          data: response({ status: 'error', data_warning: { reason: 'kis_api_error', msg: 'x' } }),
        }}
      />,
    );

    expect(screen.getByText('조회 지연')).toBeInTheDocument();
    expect(screen.getByText('1차(09:20)')).toBeInTheDocument();
    expect(screen.getByText('2차(09:30)')).toBeInTheDocument();
  });

  it('shows failure when an error response has no rows', () => {
    render(
      <InvestorTrendEstimateCard
        query={{ data: response({ status: 'error', rows: [], latest: null }) }}
      />,
    );

    expect(screen.getByText('조회 실패')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows empty state when no estimate rows exist', () => {
    render(
      <InvestorTrendEstimateCard
        query={{ data: response({ status: 'empty', rows: [], latest: null }) }}
      />,
    );

    expect(screen.getByText('추정 수급 없음')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows first-fetch loading state', () => {
    render(<InvestorTrendEstimateCard query={{ isLoading: true }} />);

    expect(screen.getByText('조회 중')).toBeInTheDocument();
  });
});
