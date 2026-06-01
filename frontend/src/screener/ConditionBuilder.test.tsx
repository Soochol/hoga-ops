import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConditionBuilder } from './ConditionBuilder';

const base = { conditions: [], universe: {} };

describe('ConditionBuilder', () => {
  it('adds a condition from the catalog menu', () => {
    const onConditions = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={onConditions} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '기간내 신고가' }));
    expect(onConditions).toHaveBeenCalledWith([expect.objectContaining({ type: 'new_high' })]);
  });

  it('repeated same-type leaves keep distinct ids', () => {
    const two = [{ id: 'p', type: 'new_high', params: { lookback: 200, period: 500 } },
                 { id: 'q', type: 'new_high', params: { lookback: 20, period: 60 } }] as any;
    render(<ConditionBuilder conditions={two} universe={{}} onConditionsChange={vi.fn()} onUniverseChange={vi.fn()} />);
    expect(screen.getAllByText('기간내 신고가')).toHaveLength(2);
  });

  it('toggles a market pre-filter', () => {
    const onUniverse = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={vi.fn()} onUniverseChange={onUniverse} />);
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI' }));
    expect(onUniverse).toHaveBeenCalledWith({ markets: ['KOSPI'] });
  });

  it('closes the menu on outside mousedown', () => {
    render(<ConditionBuilder {...base} onConditionsChange={vi.fn()} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    expect(screen.getByRole('menuitem', { name: '기간내 신고가' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menuitem', { name: '기간내 신고가' })).not.toBeInTheDocument();
  });
});
