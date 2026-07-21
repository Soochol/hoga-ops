import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SidebarCard,
  SidebarCardFooter,
  SidebarCardHeader,
  SidebarState,
} from './SidebarSurface';

describe('SidebarSurface primitives', () => {
  it('renders sidebar state text with full-height centered chrome', () => {
    render(<SidebarState>호가 데이터 없음</SidebarState>);

    expect(screen.getByText('호가 데이터 없음')).toHaveClass('grid');
    expect(screen.getByText('호가 데이터 없음')).toHaveClass('place-items-center');
    expect(screen.getByText('호가 데이터 없음')).toHaveClass('text-fg-dimmer');
  });

  it('renders sidebar cards with header and footer sections', () => {
    render(
      <SidebarCard testId="card">
        <SidebarCardHeader title="외인·기관 추정" meta="조회 중" />
        <div>body</div>
        <SidebarCardFooter left="KIS 장중 가집계" right="최근 조회 09:10" />
      </SidebarCard>,
    );

    expect(screen.getByTestId('card')).toHaveClass('bg-bg-card');
    expect(screen.getByText('외인·기관 추정')).toHaveClass('font-semibold');
    expect(screen.getByText('조회 중')).toHaveClass('font-data');
    expect(screen.getByText('KIS 장중 가집계').parentElement).toHaveClass('border-t');
  });
});
