import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  formatAggregationSlot,
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

describe('formatAggregationSlot', () => {
  it('splits the round and the actual observed HH:MM into separate pieces', () => {
    expect(formatAggregationSlot(rows[0], 0)).toEqual({ ordinal: '1', time: '09:20' });
    expect(formatAggregationSlot({
      slot: '0910',
      observed_at_ms: new Date('2026-06-16T00:40:00Z').getTime(),
    }, 1)).toEqual({ ordinal: '2', time: '09:40' });
  });

  it('claims no round when the observed timestamp is missing', () => {
    expect(formatAggregationSlot({ slot: '0920' }, 0)).toEqual({ ordinal: null, time: '09:20' });
  });
});

describe('InvestorTrendEstimateCard', () => {
  it('renders the bare table with no card chrome of its own', () => {
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    expect(screen.getByTestId('investor-trend-estimate-card')).toBeInTheDocument();
    expect(screen.getByText('차수')).toBeInTheDocument();
    expect(screen.getByText('외국인')).toBeInTheDocument();
    expect(screen.getByText('기관')).toBeInTheDocument();
    expect(screen.getByText('합산')).toBeInTheDocument();
    expect(screen.getByText('09:20')).toBeInTheDocument();
    expect(screen.getByText('09:30')).toBeInTheDocument();
    expect(screen.getByText('+1,500')).toBeInTheDocument();
    expect(screen.getByText('-200')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);

    // 창 프레임이 이미 제목·테두리를 그린다 — 카드가 두 번째 제목이나
    // 출처 각주를 덧대면 안 된다.
    expect(screen.queryByText('외인·기관 추정')).not.toBeInTheDocument();
    expect(screen.queryByText('KIS 장중 가집계 · 수량 기준')).not.toBeInTheDocument();
    expect(screen.queryByText('최근 조회 09:15')).not.toBeInTheDocument();
    // 평상시(상태 없음)엔 상태 줄도 없다.
    expect(screen.queryByText('조회 중')).not.toBeInTheDocument();
  });

  // 2026-07-30 사용자 결정: 헤더는 창 본문(--bg-card)과 같은 배경 — 밴드 금지.
  // 배경 클래스 자체는 셀마다 남아야 한다(sticky 헤더 뒤로 행이 비치는 것을 막는다.
  // border-collapse 표라 thead/tr 에 준 배경은 sticky 를 따라오지 않는다).
  it('keeps the sticky header on the window body background (no tone band)', () => {
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    for (const label of ['차수', '외국인', '기관', '합산']) {
      const cell = screen.getByText(label);
      expect(cell).toHaveClass('bg-bg-card');
      expect(cell).not.toHaveClass('bg-bg-subtle');
    }
    expect(screen.getByText('차수').closest('thead')).toHaveClass('sticky');
  });

  // `bg-bg` 로 칠하던 시절엔 Obsidian·Ledger 에서 --bg 와 --bg-card 가 같은 값이라
  // 강조가 한 픽셀도 바뀌지 않았다. 토큰 값이 합쳐져도 테스트가 잡도록 클래스를 못박는다.
  it('marks the latest row with a tint that is actually visible', () => {
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    const latest = screen.getByTestId('investor-estimate-row-latest');
    expect(within(latest).getByText('09:30')).toBeInTheDocument();
    expect(latest).toHaveClass('bg-tint-selection');
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
    expect(screen.getByText('09:20')).toBeInTheDocument();
    expect(screen.getByText('09:30')).toBeInTheDocument();
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
