import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { ConditionBuilder } from './ConditionBuilder';
import { reconcileExpression } from './conditionExpression';
import { NumericInputValidationContext, useNumericInputValidation } from './numericInputValidation';
import { CONDITION_CATALOG } from './catalog';

const leaves: ConditionLeaf[] = [
  { id: 'a', type: 'trade_value', params: { min_eok: 100 } },
  { id: 'b', type: 'new_high_today', params: { period: 20 } },
  { id: 'c', type: 'volume_ratio', params: { offset: 0, period: 20, op: 'gte', pct: 200 } },
];
beforeEach(() => localStorage.clear());
function Editor({ initial = [] as ConditionLeaf[], formula = null as string | null }) {
  const [conditions, setConditions] = useState(initial), [expression, setExpression] = useState(formula);
  const validation = useNumericInputValidation();
  return <NumericInputValidationContext.Provider value={validation.report}>
    <ConditionBuilder conditions={conditions} universe={{}} expression={expression} onExpressionChange={setExpression}
      onConditionsChange={next => { setExpression(reconcileExpression(expression, conditions, next)); setConditions(next); }} onUniverseChange={vi.fn()} />
    <output data-testid="saved-state" data-invalid={validation.invalid}>{JSON.stringify({ conditions, expression })}</output>
  </NumericInputValidationContext.Provider>;
}
const state = () => JSON.parse(screen.getByTestId('saved-state').textContent!);
const dialog = () => screen.getByRole('dialog', { name: '조건 설정' });
function choose(name: string) {
  fireEvent.change(within(dialog()).getByLabelText('조건 검색'), { target: { value: name } });
  fireEvent.click(within(dialog()).getByRole('button', { name: `${name} 선택` }));
}

describe('ConditionBuilder', () => {
  it('opens a searchable modal and commits the configured draft only on Add', () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    expect(within(dialog()).getByLabelText('조건 검색')).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    choose('기간내 신고가');
    fireEvent.change(within(dialog()).getByLabelText('최근 기간(봉)'), { target: { value: '17' } });
    expect(state().conditions).toEqual([]);
    fireEvent.click(within(dialog()).getByRole('button', { name: '추가' }));
    expect(state().conditions[0]).toMatchObject({ type: 'new_high', params: { lookback: 17, period: 500 } });
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: '추가' }));
    expect(state().conditions[0].id).not.toBe(state().conditions[1].id);
    fireEvent.click(within(dialog()).getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^[AB] 기간내 신고가 설정$/ })).toHaveLength(2);
  });

  it('discards unadded drafts and search Escape leaves the modal open first', () => {
    render(<Editor />);
    const trigger = screen.getByRole('button', { name: '조건 추가' });
    trigger.focus();fireEvent.click(trigger); choose('이동평균');
    const search = within(dialog()).getByLabelText('조건 검색');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue(''); expect(dialog()).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state().conditions).toEqual([]); expect(trigger).toHaveFocus();
  });

  it('edits a selected condition and validates manual parentheses without regrouping', () => {
    render(<Editor initial={leaves} formula="A OR B AND C" />);
    fireEvent.click(screen.getByRole('button', { name: 'B 신고가 설정' }));
    expect(within(dialog()).getByRole('heading', { name: 'B · 신고가' })).toBeInTheDocument();
    const input = within(dialog()).getByLabelText('조건 조합식');
    expect(input).toHaveValue('A OR B AND C');
    expect(screen.queryByRole('button', { name: '() 묶기' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'A AND (B OR C' } });
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('닫는 괄호');
    expect(input).toHaveValue('A AND (B OR C');
    fireEvent.change(input, { target: { value: 'A AND ((B OR C))' } });
    fireEvent.change(within(dialog()).getByLabelText('신고 기준 기간(봉)'), { target: { value: '60' } });
    expect(state().expression).toBe('A AND ((B OR C))');
    expect(state().conditions[1].params.period).toBe(60);
    fireEvent.click(within(dialog()).getByRole('button', { name: '모두 OR' }));
    expect(input).toHaveValue('A OR B OR C');
  });

  it('inserts literal brackets and can replace a selected operator with undo', () => {
    render(<Editor initial={leaves} formula="A AND B AND C" />);
    fireEvent.click(screen.getByRole('button', { name: '조건 조합 편집' }));
    const input = within(dialog()).getByLabelText('조건 조합식') as HTMLTextAreaElement;
    input.focus();input.setSelectionRange(2, 5);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OR 조합식에 입력' }));
    expect(input).toHaveValue('A OR B AND C');
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });expect(input).toHaveValue('A AND B AND C');
    input.setSelectionRange(0, 0);
    fireEvent.click(within(dialog()).getByRole('button', { name: '( 조합식에 입력' }));
    expect(input).toHaveValue('( A AND B AND C');
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('닫는 괄호');
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.click(within(dialog()).getByRole('button', { name: ') 조합식에 입력' }));
    expect(input).toHaveValue('( A AND B AND C )');
    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps invalid new drafts isolated and blocks only committing that draft', () => {
    render(<Editor initial={leaves} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));choose('이동평균');
    fireEvent.change(within(dialog()).getByLabelText('이동평균 기간(봉)'), { target: { value: '1001' } });
    expect(within(dialog()).getByRole('button', { name: '추가' })).toBeDisabled();
    expect(screen.getByTestId('saved-state')).toHaveAttribute('data-invalid', 'false');
    expect(state().conditions).toHaveLength(3);
    fireEvent.click(within(dialog()).getByRole('button', { name: '닫기' }));
    fireEvent.click(screen.getByRole('button', { name: 'A 거래대금 설정' }));
    fireEvent.change(within(dialog()).getByLabelText('최소 거래대금(억)'), { target: { value: '' } });
    expect(screen.getByTestId('saved-state')).toHaveAttribute('data-invalid', 'true');
    fireEvent.click(within(dialog()).getByRole('button', { name: '조건 제거' }));
    expect(screen.getByTestId('saved-state')).toHaveAttribute('data-invalid', 'false');
  });

  it('retains invalid numeric drafts across selection and close, while unadded drafts reset', () => {
    render(<Editor initial={leaves} />);
    fireEvent.click(screen.getByRole('button', { name: 'A 거래대금 설정' }));
    fireEvent.change(within(dialog()).getByLabelText('최소 거래대금(억)'), { target: { value: '' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'B 신고가 설정' }));
    expect(screen.getByTestId('saved-state')).toHaveAttribute('data-invalid', 'true');
    fireEvent.click(within(dialog()).getByRole('button', { name: '닫기' }));
    expect(screen.getByTestId('saved-state')).toHaveAttribute('data-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'A 거래대금 설정' }));
    expect(within(dialog()).getByLabelText('최소 거래대금(억)')).toHaveValue('');
    fireEvent.change(within(dialog()).getByLabelText('최소 거래대금(억)'), { target: { value: '200' } });
    expect(screen.getByTestId('saved-state')).toHaveAttribute('data-invalid', 'false');
    fireEvent.click(within(dialog()).getByRole('button', { name: '닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' })); choose('이동평균');
    fireEvent.change(within(dialog()).getByLabelText('이동평균 기간(봉)'), { target: { value: '1001' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: '닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    expect(within(dialog()).getByLabelText('이동평균 기간(봉)')).toHaveValue('20');
    expect(within(dialog()).getByRole('button', { name: '추가' })).toBeEnabled();
  });

  it('preserves written parentheses when adding, dragging and deleting conditions', () => {
    render(<Editor initial={leaves} formula="A OR (B AND C)" />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));choose('현재가 범위');
    fireEvent.click(within(dialog()).getByRole('button', { name: '추가' }));
    expect(state().expression).toBe('A OR (B AND C) AND D');
    fireEvent.click(within(dialog()).getByRole('button', { name: '닫기' }));
    const handles = screen.getAllByRole('button', { name: '조건 순서 변경' });
    fireEvent.dragStart(handles[2]);fireEvent.dragOver(handles[0]);fireEvent.drop(handles[0]);
    expect(state().expression).toBe('B OR (C AND A) AND D');
    fireEvent.click(screen.getByRole('button', { name: 'C 조건 제거' }));
    expect(state().expression).toBe('B OR (A) AND C');
  });

  it.each(Object.keys(CONDITION_CATALOG))('every catalog family is searchable: %s', type => {
    const name = CONDITION_CATALOG[type as keyof typeof CONDITION_CATALOG].label;
    render(<Editor />);fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));choose(name);
    expect(within(dialog()).getByRole('group', { name: `${name} 조건` })).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: '추가' })).toBeEnabled();
  });

  it('keeps universe editing separate', () => {
    const onUniverse = vi.fn();
    render(<ConditionBuilder conditions={[]} universe={{}} onConditionsChange={vi.fn()} onUniverseChange={onUniverse} />);
    fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI' }));expect(onUniverse).toHaveBeenCalledWith({ markets: ['KOSPI'] });
  });
});
