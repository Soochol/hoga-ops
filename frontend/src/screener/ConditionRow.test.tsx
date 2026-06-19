import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConditionRow } from './ConditionRow';
import type { ConditionLeaf } from '../api/screener';

const leaf: ConditionLeaf = { id: 'x', type: 'new_high', params: { lookback: 200, period: 500 } };

describe('ConditionRow', () => {
  it('renders the ParamForm immediately with no collapse caret', () => {
    render(<ConditionRow leaf={leaf} onChange={vi.fn()} onClone={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText('lookback (N)')).toBeInTheDocument();
    expect(screen.getByLabelText('period (M)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '펼치기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '접기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '조건 제거' })).toBeInTheDocument();
  });

  it('MA condition exposes OHLC source select', () => {
    const onChange = vi.fn();
    render(<ConditionRow
      leaf={{ id: 'm', type: 'ma', params: { period: 20, relation: 'above' } }}
      onChange={onChange}
      onClone={vi.fn()}
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
