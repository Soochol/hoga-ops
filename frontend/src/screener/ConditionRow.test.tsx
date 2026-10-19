import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ConditionRow } from './ConditionRow';
import { CONDITION_CATALOG, makeLeaf } from './catalog';
import type { ConditionLeaf, ConditionType } from '../api/screener';

const leaf: ConditionLeaf = { id: 'x', type: 'new_high', params: { lookback: 200, period: 500 } };

describe('ConditionRow', () => {
  it('starts expanded and keeps parameters mounted when collapsed', () => {
    const onChange = vi.fn();
    render(<ConditionRow leaf={leaf} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.getByLabelText('최근 기간(봉)')).toBeInTheDocument();
    expect(screen.getByLabelText('신고 기준 기간(봉)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '기간내 신고가 접기' }));
    expect(screen.getByLabelText('최근 기간(봉)')).not.toBeVisible();
    expect(screen.getByText('봉 기준')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '기간내 신고가 펼치기' }));
    expect(screen.getByLabelText('최근 기간(봉)')).toHaveValue(200);
    expect(screen.getByLabelText('신고 기준 기간(봉)')).toHaveValue(500);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '조건 복제' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '조건 제거' })).toBeInTheDocument();
  });

  it.each(Object.keys(CONDITION_CATALOG) as ConditionType[])('%s keeps its full saved params when edited after folding', type => {
    const initial = makeLeaf(type);
    const onChange = vi.fn();
    const name = CONDITION_CATALOG[type].label;
    render(<ConditionRow leaf={initial} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: `${name} 접기` }));
    fireEvent.click(screen.getByRole('button', { name: `${name} 펼치기` }));
    const card = screen.getByRole('group', { name: `${name} 조건` });
    const input = within(card).getAllByRole('spinbutton')[0];
    fireEvent.change(input, { target: { value: '17' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...initial,
      params: { ...initial.params, [type === 'price_range' ? 'min'
        : type === 'trade_value' ? 'min_eok'
        : type === 'new_high_today' || type === 'new_high_vol_today' || type === 'high_off_peak' || type === 'ma' ? 'period'
        : type === 'change_pct' ? 'pct'
        : type === 'ask_depth_renewal' || type === 'bid_depth_renewal' ? 'threshold_pct' : 'lookback']: 17 } });
  });

  it('fast entry preserves independent candle settings and saved policy', () => {
    const onChange = vi.fn();
    render(<ConditionRow leaf={{ id: 'amount', type: 'trade_value', params: {
      min_eok: 123, timeframe: 'W', include_open_bar: false,
    } }} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '500억' }));
    expect(onChange).toHaveBeenLastCalledWith({ id: 'amount', type: 'trade_value', params: {
      min_eok: 500, timeframe: 'W', include_open_bar: false,
    } });
  });

  it('MA condition exposes OHLC source select', () => {
    const onChange = vi.fn();
    render(<ConditionRow
      leaf={{ id: 'm', type: 'ma', params: { period: 20, relation: 'above' } }}
      onChange={onChange}
      onRemove={vi.fn()}
    />);

    const source = screen.getByLabelText('MA 기준가격');
    expect(source).toHaveValue('close');
    expect(screen.getByRole('option', { name: '시가' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '고가' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '저가' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '종가' })).toBeInTheDocument();

    fireEvent.change(source, { target: { value: 'open' } });
    expect(onChange).toHaveBeenCalledWith({
      id: 'm',
      type: 'ma',
      params: { period: 20, relation: 'above', source: 'open' },
    });
  });
});
