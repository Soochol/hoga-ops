import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConditionBuilder } from './ConditionBuilder';

const base = { conditions: [], universe: {} };

describe('ConditionBuilder', () => {
  it('adds a condition from the catalog menu', () => {
    const onConditions = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={onConditions} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    expect(screen.getByText('신고가/거래량')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '기간내 신고가' }));
    expect(onConditions).toHaveBeenCalledWith([expect.objectContaining({ type: 'new_high' })]);
  });

  it('groups add-condition options by category', () => {
    render(<ConditionBuilder {...base} onConditionsChange={vi.fn()} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    expect(screen.getByText('가격')).toBeInTheDocument();
    expect(screen.getAllByText('거래대금').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('신고가/거래량')).toBeInTheDocument();
    expect(screen.getAllByText('이동평균').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('등락률').length).toBeGreaterThanOrEqual(1);
  });

  it('bare "신고가" menu item adds the 당일 variant (new_high_today)', () => {
    // Disambiguation guard: exact-name match (not /신고가$/) so bare 신고가 → 당일,
    // 기간내 신고가 → new_high. Pins the rename in the 당일 direction at the menu level.
    const onConditions = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={onConditions} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '신고가' }));
    expect(onConditions).toHaveBeenCalledWith([expect.objectContaining({ type: 'new_high_today' })]);
  });

  it('repeated same-type leaves keep distinct ids', () => {
    const two = [{ id: 'p', type: 'new_high', params: { lookback: 200, period: 500 } },
                 { id: 'q', type: 'new_high', params: { lookback: 20, period: 60 } }] as any;
    render(<ConditionBuilder conditions={two} universe={{}} onConditionsChange={vi.fn()} onUniverseChange={vi.fn()} />);
    expect(screen.getAllByText('기간내 신고가')).toHaveLength(2);
  });

  it('duplicates a condition with the same type and params but a new id', () => {
    const condition = { id: 'p', type: 'ma', params: { period: 20, relation: 'above' } } as any;
    const onConditions = vi.fn();
    render(<ConditionBuilder conditions={[condition]} universe={{}} onConditionsChange={onConditions} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 복제' }));
    expect(onConditions).toHaveBeenCalledWith([
      condition,
      expect.objectContaining({ type: 'ma', params: condition.params }),
    ]);
    expect(onConditions.mock.calls[0][0][1].id).not.toBe('p');
  });

  it('delegates universe editing to the 사전필터 modal (header button → modal → onUniverseChange)', () => {
    // 인라인 시장 토글이 UniverseFilterModal 로 이동(전역 사전필터 → 센터 모달).
    // ConditionBuilder 는 헤더 버튼만 두고 onUniverseChange 를 위임한다.
    const onUniverse = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={vi.fn()} onUniverseChange={onUniverse} />);
    fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));  // 모달 열기 (기본 '시장' pane)
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI' }));      // 시장 토글
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
