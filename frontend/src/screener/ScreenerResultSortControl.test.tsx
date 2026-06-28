import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ScreenerResultSortControl } from './ScreenerResultSortControl';

describe('ScreenerResultSortControl', () => {
  it('renders one cycling sort button with the active mode icon and state copy', () => {
    render(<ScreenerResultSortControl mode="default" onChange={vi.fn()} />);

    const button = screen.getByRole('button', { name: '스크리너 결과 정렬' });
    expect(within(button).getByTestId('sort-icon-default')).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription('현재 기본 순서, 클릭하면 등락률 높은 순');
  });

  it('cycles to the next mode from the current mode', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ScreenerResultSortControl mode="default" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '스크리너 결과 정렬' }));
    expect(onChange).toHaveBeenNthCalledWith(1, { field: 'change_pct', direction: 'desc' });

    rerender(<ScreenerResultSortControl mode={{ field: 'change_pct', direction: 'desc' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '스크리너 결과 정렬' }));
    expect(onChange).toHaveBeenNthCalledWith(2, { field: 'change_pct', direction: 'asc' });

    rerender(<ScreenerResultSortControl mode={{ field: 'change_pct', direction: 'asc' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '스크리너 결과 정렬' }));
    expect(onChange).toHaveBeenNthCalledWith(3, 'default');
  });

  it('disables the cycling button when disabled', () => {
    render(<ScreenerResultSortControl mode={{ field: 'change_pct', direction: 'desc' }} onChange={vi.fn()} disabled />);

    expect(screen.getByRole('button', { name: '스크리너 결과 정렬' })).toBeDisabled();
  });
});
