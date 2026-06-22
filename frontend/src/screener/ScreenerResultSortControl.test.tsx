import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ScreenerResultSortControl } from './ScreenerResultSortControl';

describe('ScreenerResultSortControl', () => {
  it('renders three explicit sort buttons and marks the active mode', () => {
    render(<ScreenerResultSortControl mode="default" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: '기본 순서' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '등락률 낮은 순' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '등락률 높은 순' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByRole('button', { name: '기본 순서' })).getByTestId('sort-icon-default')).toBeInTheDocument();
  });

  it('calls onChange with the requested mode', () => {
    const onChange = vi.fn();
    render(<ScreenerResultSortControl mode="default" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '등락률 낮은 순' }));
    fireEvent.click(screen.getByRole('button', { name: '등락률 높은 순' }));
    fireEvent.click(screen.getByRole('button', { name: '기본 순서' }));

    expect(onChange).toHaveBeenNthCalledWith(1, 'change_pct_asc');
    expect(onChange).toHaveBeenNthCalledWith(2, 'change_pct_desc');
    expect(onChange).toHaveBeenNthCalledWith(3, 'default');
  });

  it('disables all buttons when disabled', () => {
    render(<ScreenerResultSortControl mode="change_pct_desc" onChange={vi.fn()} disabled />);

    expect(screen.getByRole('button', { name: '기본 순서' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '등락률 낮은 순' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '등락률 높은 순' })).toBeDisabled();
  });
});

