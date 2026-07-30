import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidebarState } from './SidebarSurface';

describe('SidebarSurface primitives', () => {
  it('renders sidebar state text with full-height centered chrome', () => {
    render(<SidebarState>호가 데이터 없음</SidebarState>);

    expect(screen.getByText('호가 데이터 없음')).toHaveClass('grid');
    expect(screen.getByText('호가 데이터 없음')).toHaveClass('place-items-center');
    expect(screen.getByText('호가 데이터 없음')).toHaveClass('text-fg-dimmer');
  });
});
