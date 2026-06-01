import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConditionRow } from './ConditionRow';
import type { ConditionLeaf } from '../api/screener';

const leaf: ConditionLeaf = { id: 'x', type: 'new_high', params: { lookback: 200, period: 500 } };

describe('ConditionRow', () => {
  it('renders the ParamForm immediately with no collapse caret', () => {
    render(<ConditionRow leaf={leaf} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText('lookback (N)')).toBeInTheDocument();
    expect(screen.getByLabelText('period (M)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '펼치기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '접기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '조건 제거' })).toBeInTheDocument();
  });
});
