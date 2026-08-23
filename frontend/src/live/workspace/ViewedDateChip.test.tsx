import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ViewedDateChip } from './ViewedDateChip';

afterEach(cleanup);

describe('ViewedDateChip', () => {
  it('보고 있는 날짜를 말한다 — 시간축이 하루 안에서는 날짜를 안 찍는다', () => {
    render(<ViewedDateChip date="20260820" onReturn={vi.fn()} />);
    const chip = screen.getByTestId('live-viewed-date-chip');
    expect(chip.textContent).toContain('08-20');
    expect(chip.getAttribute('title')).toContain('20260820');
  });

  it('× 는 라이브 엣지로 돌려보낸다', () => {
    const onReturn = vi.fn();
    render(<ViewedDateChip date="20260820" onReturn={onReturn} />);
    fireEvent.click(screen.getByLabelText('최근 시각으로 돌아가기'));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('해가 다르면 연도까지 편다 — 작년 같은 날과 구별돼야 한다', () => {
    render(<ViewedDateChip date="20250820" onReturn={vi.fn()} />);
    expect(screen.getByTestId('live-viewed-date-chip').textContent).toContain('25-08-20');
  });
});
