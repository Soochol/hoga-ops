import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ConditionRow } from './ConditionRow';
import { CONDITION_CATALOG, makeLeaf } from './catalog';
import type { ConditionLeaf, ConditionType } from '../api/screener';

const leaf: ConditionLeaf = { id: 'x', type: 'new_high', params: { lookback: 200, period: 500 } };

describe('ConditionRow', () => {
  it('keeps every parameter visible without a fold control', () => {
    const onChange = vi.fn();
    render(<ConditionRow leaf={leaf} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.getByLabelText('최근 기간(봉)')).toBeInTheDocument();
    expect(screen.getByLabelText('신고 기준 기간(봉)')).toBeInTheDocument();
    expect(screen.getByLabelText('최근 기간(봉)')).toBeVisible();
    expect(screen.getByLabelText('신고 기준 기간(봉)')).toBeVisible();
    expect(screen.queryByRole('button', { name: /접기|펼치기/ })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '조건 복제' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '조건 제거' })).toBeInTheDocument();
  });

  it.each(Object.keys(CONDITION_CATALOG) as ConditionType[])('%s keeps all parameters visible and preserves saved values when edited', type => {
    const initial = makeLeaf(type);
    const onChange = vi.fn();
    const name = CONDITION_CATALOG[type].label;
    render(<ConditionRow leaf={initial} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /접기|펼치기/ })).not.toBeInTheDocument();
    const card = screen.getByRole('group', { name: `${name} 조건` });
    const input = within(card).getAllByRole('spinbutton')[0];
    fireEvent.change(input, { target: { value: '17' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...initial,
      params: { ...initial.params, [type === 'price_range' ? 'min'
        : type === 'trade_value' ? 'min_eok'
        : type === 'new_high_today' || type === 'new_high_vol_today' || type === 'high_off_peak' || type === 'ma' || type === 'bollinger_breakout_today' ? 'period'
        : type === 'change_pct' ? 'pct'
        : type === 'ask_depth_renewal' || type === 'bid_depth_renewal' ? 'threshold_pct' : 'lookback']: 17 } });
  });

  it('opens the breakout explanation without hiding any of its settings', () => {
    render(<ConditionRow leaf={makeLeaf('bollinger_breakout')} onChange={vi.fn()} onRemove={vi.fn()} />);
    const source = screen.getByRole('combobox', { name: '돌파 비교가격' });
    fireEvent.click(screen.getByRole('button', { name: '기간내 볼린저밴드 돌파 도움말' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('최신 봉을 포함한 기간');
    expect(source).toBeVisible();
    expect(screen.getByLabelText('볼린저 기간')).toBeVisible();
    expect(screen.getByLabelText('표준편차 배수')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(source).toBeVisible();
  });

  it('manual entry preserves independent candle settings and saved policy', () => {
    const onChange = vi.fn();
    render(<ConditionRow leaf={{ id: 'amount', type: 'trade_value', params: {
      min_eok: 123, timeframe: 'W', include_open_bar: false,
    } }} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('최소 거래대금(억)'), { target: { value: '500' } });
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
