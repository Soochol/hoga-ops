import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StockDateGroupListItem } from './StockDateGroupListItem';
import type { StockDateGroup } from './types';

const sampleGroup: StockDateGroup = {
  code: '005930',
  name: '삼성전자',
  dates: [],
  lastCapturedAt: Date.UTC(2026, 4, 22, 6, 0),
  totalSizeBytes: 38_700_000,
};
const groupForView: StockDateGroup = {
  ...sampleGroup,
  dates: [{} as never, {} as never, {} as never], // 3 dates
};

describe('StockDateGroupListItem', () => {
  it('shows code, name, and date count', () => {
    render(<StockDateGroupListItem group={groupForView} active={false} onClick={() => {}} />);
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText('3 dates')).toBeTruthy();
  });

  it('shows formatted last-captured date (MM-DD) and total size', () => {
    render(<StockDateGroupListItem group={groupForView} active={false} onClick={() => {}} />);
    expect(screen.getByText(/최근 05-22/)).toBeTruthy();
    expect(screen.getByText('36.9 MB')).toBeTruthy();
  });

  it('applies active styling when active=true', () => {
    const { container } = render(
      <StockDateGroupListItem group={groupForView} active={true} onClick={() => {}} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/bg-tint-selection/);
  });

  it('fires onClick with the group code', () => {
    const onClick = vi.fn();
    const { container } = render(
      <StockDateGroupListItem group={groupForView} active={false} onClick={onClick} />,
    );
    (container.firstElementChild as HTMLElement).click();
    expect(onClick).toHaveBeenCalledWith('005930');
  });

  it('shows "1 date" singular for one-date group', () => {
    const single: StockDateGroup = { ...groupForView, dates: [{} as never] };
    render(<StockDateGroupListItem group={single} active={false} onClick={() => {}} />);
    expect(screen.getByText('1 date')).toBeTruthy();
  });

  it('renders last-captured date in Asia/Seoul (uses fmtShortDate from lastCapturedAt)', () => {
    // 2026-05-22 06:00 UTC == 15:00 KST → MM-DD = "05-22"
    render(<StockDateGroupListItem group={groupForView} active={false} onClick={() => {}} />);
    expect(screen.getByText(/05-22/)).toBeTruthy();
  });
});
