import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OccurrenceAction } from './OccurrenceExclusions';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';

afterEach(cleanup);
function setup(otherRows: number) {
  const exclude = vi.fn();
  const controller: OccurrenceExclusions = {
    exclusions: [], busy: false, error: null, ready: true, lastExcluded: null,
    conditions: [{ id: 'v', type: 'trade_value_period', params: { lookback: 3, min_eok: 1 } }],
    exclude, restore: vi.fn(), affectedOtherRows: () => otherRows,
  };
  const rendered = render(<OccurrenceAction code="005930" name="삼성전자"
    occurrence={{ condition_id: 'v', condition_key: 'key', date: '2026-09-09' }} controller={controller} />);
  rendered.container.style.transform = 'translateY(300px)';
  return exclude;
}
it('excludes a single event directly when other conditions remain satisfied', () => {
  const exclude = setup(0);
  fireEvent.click(screen.getByRole('button', { name: /발생 건 제외/ }));
  expect(exclude).toHaveBeenCalledWith('005930', '삼성전자',
    { condition_id: 'v', condition_key: 'key', date: '2026-09-09' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('explains AND impact and allows cancellation before writing', () => {
  const exclude = setup(2);
  fireEvent.click(screen.getByRole('button', { name: /발생 건 제외/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent('다른 발생 2건도 결과에서 빠집니다');
  expect(exclude).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(exclude).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /발생 건 제외/ }));
  fireEvent.click(screen.getByRole('button', { name: '이 발생 건 제외' }));
  expect(exclude).toHaveBeenCalledTimes(1);
});

it('portals the impact dialog outside transformed rows and closes with Escape', () => {
  const exclude = setup(2);
  fireEvent.click(screen.getByRole('button', { name: /발생 건 제외/ }));
  expect(screen.getByRole('dialog').parentElement).toBe(document.body);
  fireEvent.keyDown(screen.getByRole('button', { name: '취소' }), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(exclude).not.toHaveBeenCalled();
});
