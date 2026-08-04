import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  formatAggregationSlot,
  formatAmount,
  formatQty,
  InvestorTrendEstimateCard,
  toDescendingDisplayRows,
} from './InvestorTrendEstimateCard';
import type { LiveInvestorTrendEstimateResponse } from '../api/liveInvestorTrendEstimate';
import { useInvestorEstimateUnitStore } from '../state/investorEstimateUnit';

const rows: LiveInvestorTrendEstimateResponse['rows'] = [
  {
    slot: '1',
    observed_at_ms: new Date('2026-06-16T00:20:00Z').getTime(),
    foreign_qty: 1500,
    institution_qty: -200,
    sum_qty: 1300,
    foreign_amt_mwon: 360,
    institution_amt_mwon: -48,
    sum_amt_mwon: 312,
  },
  {
    slot: '2',
    observed_at_ms: new Date('2026-06-16T00:30:00Z').getTime(),
    foreign_qty: null,
    institution_qty: 0,
    sum_qty: 0,
    foreign_amt_mwon: null,
    institution_amt_mwon: 0,
    sum_amt_mwon: 0,
  },
];

beforeEach(() => {
  // 단위는 전역 스토어 + localStorage 라 테스트 간에 샌다. 한쪽만 지우면 다음
  // 테스트가 이전 클릭을 물려받는다.
  localStorage.clear();
  useInvestorEstimateUnitStore.setState({ unit: 'qty' });
});

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

describe('formatQty', () => {
  // 2026-08-04 사용자 결정: 만 단위 축약 금지. 20,000 은 "2만" 이 아니다.
  it('never abbreviates — raw signed comma values at every magnitude', () => {
    expect(formatQty(20_000)).toBe('+20,000');
    expect(formatQty(-1_925_000)).toBe('-1,925,000');
    expect(formatQty(1500)).toBe('+1,500');
    expect(formatQty(-200)).toBe('-200');
  });

  // 옛 판(formatQtyCompact)은 벤더가 이미 천주로 반올림해 보낸 값 위에 만 단위
  // 반올림을 한 겹 더 얹어 -1,925,000 을 -193만(= -1,930,000)으로 만들었다.
  it('does not round away the vendor thousand-share granularity', () => {
    expect(formatQty(-1_925_000)).not.toContain('만');
    expect(formatQty(-1_925_000)).toContain('925');
  });

  it('handles zero and null', () => {
    expect(formatQty(0)).toBe('0');
    expect(formatQty(null)).toBe('-');
  });
});

describe('formatAmount', () => {
  // 입력은 벤더 단위(백만원)다. 실측(005930 · 2026-08-04 14:31) 기준 값.
  it('scales 백만원 to 억 so the axis is visually distinct from quantity', () => {
    expect(formatAmount(-451_250)).toBe('-4,513억');
    expect(formatAmount(-212_372)).toBe('-2,124억');
    expect(formatAmount(-663_622)).toBe('-6,636억');
  });

  it('keeps one decimal only below 10억, where the digit still carries information', () => {
    expect(formatAmount(-540)).toBe('-5.4억');
    expect(formatAmount(360)).toBe('+3.6억');
    expect(formatAmount(-21_796)).toBe('-218억');
  });

  // 부호만 남은 0 은 방향을 주장하지 않는다 — "-0.0억" 은 매도처럼 읽힌다.
  it('folds sub-threshold magnitudes to a bare zero', () => {
    expect(formatAmount(4)).toBe('0');
    expect(formatAmount(0)).toBe('0');
    expect(formatAmount(null)).toBe('-');
  });

  // 배포 순서 방어 — 프론트가 백엔드보다 먼저 나가면 금액 축 키가 응답에 아예 없다.
  // 타입은 `number | null` 이라 이 경로를 만들어 주지 않고, /browse 실측에서만 잡혔다
  // (표 전체가 "NaN억" 으로 덮였다).
  it('renders a dash when the axis is missing from the response entirely', () => {
    expect(formatAmount(undefined)).toBe('-');
    expect(formatQty(undefined)).toBe('-');
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

describe('toDescendingDisplayRows', () => {
  it('puts the newest round first', () => {
    expect(toDescendingDisplayRows(rows).map((r) => r.ordinal)).toEqual(['2', '1']);
    expect(toDescendingDisplayRows(rows).map((r) => r.time)).toEqual(['09:30', '09:20']);
  });

  // 차수 폴백(`index + 1`)은 원본 오름차순 인덱스로 계산해야 한다 — 뒤집은 뒤에
  // 계산하면 최신 행이 1차가 되어 번호가 거꾸로 매겨진다.
  it('numbers non-decimal slots by their ascending position, not the display position', () => {
    const hhmmRows: LiveInvestorTrendEstimateResponse['rows'] = [
      { ...rows[0], slot: '0920' },
      { ...rows[1], slot: '0930' },
    ];

    expect(toDescendingDisplayRows(hhmmRows)).toEqual([
      { row: hhmmRows[1], ordinal: '2', time: '09:30' },
      { row: hhmmRows[0], ordinal: '1', time: '09:20' },
    ]);
  });

  it('leaves the source array untouched', () => {
    const source = [...rows];
    toDescendingDisplayRows(source);
    expect(source).toEqual(rows);
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

  // 존재 단언(`getByText('09:20')`)만으로는 오름/내림차순을 구분하지 못한다 —
  // 순서는 행 배열의 위치로 못박아야 뒤집힘이 회귀로 잡힌다.
  it('lists the newest round first (descending)', () => {
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    const [, first, second] = screen.getAllByRole('row'); // [0] 은 헤더 행
    expect(within(first).getByText('09:30')).toBeInTheDocument();
    expect(within(first).getByText('2')).toBeInTheDocument();
    expect(within(second).getByText('09:20')).toBeInTheDocument();
    expect(within(second).getByText('1')).toBeInTheDocument();
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
          data: response({ status: 'error', data_warning: { reason: 'api_error', msg: 'x' } }),
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

describe('unit chip', () => {
  function chip() {
    return screen.getByRole('button', { name: /표시 단위/ });
  }

  it('starts on quantity and shows raw share counts', () => {
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    expect(chip()).toHaveTextContent('주');
    expect(chip()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('+1,500')).toBeInTheDocument();
  });

  // 값이 실제로 바뀌는 것까지 봐야 배선이 검증된다 — 칩 글자만 확인하면 라벨은
  // 토글되는데 셀은 여전히 수량 필드를 읽는 버그가 통과한다.
  it('switches every value column to 억 when pressed', async () => {
    const user = userEvent.setup();
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    await user.click(chip());

    expect(chip()).toHaveTextContent('억');
    expect(chip()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('+3.6억')).toBeInTheDocument();
    expect(screen.getByText('-0.5억')).toBeInTheDocument();
    expect(screen.getByText('+3.1억')).toBeInTheDocument();
    expect(screen.queryByText('+1,500')).not.toBeInTheDocument();
  });

  it('persists the choice so a reopened window keeps the unit', async () => {
    const user = userEvent.setup();
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    await user.click(chip());

    expect(useInvestorEstimateUnitStore.getState().unit).toBe('amount');
    expect(localStorage.getItem('live.investorEstimateUnit.v1')).toContain('amount');
  });

  // 부호 색은 축이 바뀌어도 그대로여야 한다 — 금액과 수량의 부호는 같은 사실이고,
  // 색이 튀면 데이터가 갱신된 것처럼 읽힌다.
  it('keeps the sign colouring identical across both axes', async () => {
    const user = userEvent.setup();
    render(<InvestorTrendEstimateCard query={{ data: response() }} />);

    expect(screen.getByText('+1,500')).toHaveClass('text-price-up');
    expect(screen.getByText('-200')).toHaveClass('text-price-down');

    await user.click(chip());

    expect(screen.getByText('+3.6억')).toHaveClass('text-price-up');
    expect(screen.getByText('-0.5억')).toHaveClass('text-price-down');
  });
});
