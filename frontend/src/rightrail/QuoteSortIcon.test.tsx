import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuoteSortIcon } from './QuoteSortIcon';
import { quoteSortModeDescription } from './quoteSortDescription';

describe('QuoteSortIcon', () => {
  it('renders distinct icons for default, ascending, and descending modes', () => {
    const { rerender } = render(<QuoteSortIcon mode="default" />);
    expect(screen.getByTestId('sort-icon-default')).toBeInTheDocument();

    rerender(<QuoteSortIcon mode="change_pct_asc" />);
    expect(screen.getByTestId('sort-icon-asc')).toBeInTheDocument();

    rerender(<QuoteSortIcon mode="change_pct_desc" />);
    expect(screen.getByTestId('sort-icon-desc')).toBeInTheDocument();
  });

  it('describes the current cycle state for the existing Watchlist one-button control', () => {
    expect(quoteSortModeDescription('default')).toBe('현재 기본 정렬, 클릭하면 등락률 내림차순');
    expect(quoteSortModeDescription('change_pct_desc')).toBe('현재 등락률 내림차순, 클릭하면 등락률 오름차순');
    expect(quoteSortModeDescription('change_pct_asc')).toBe('현재 등락률 오름차순, 클릭하면 기본 정렬');
    expect(quoteSortModeDescription(undefined)).toBe('현재 기본 정렬, 클릭하면 등락률 내림차순');
  });
});
