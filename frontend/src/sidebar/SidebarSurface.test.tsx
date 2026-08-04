import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidebarState } from './SidebarSurface';

describe('SidebarSurface primitives', () => {
  it('renders sidebar state text with full-height centered chrome', () => {
    render(<SidebarState>호가 데이터 없음</SidebarState>);

    expect(screen.getByText('호가 데이터 없음')).toHaveClass('grid');
    expect(screen.getByText('호가 데이터 없음')).toHaveClass('place-items-center');
    // 소형 텍스트(text-xs)의 3차 색은 --fg-dim 이다 — --fg-dimmer 는 대비 3.15:1(다크)
    // /2.99:1(라이트)로 11.8px 본문에서 WCAG AA(4.5:1) 미달이라 2026-08-04 에 승격했다.
    expect(screen.getByText('호가 데이터 없음')).toHaveClass('text-fg-dim');
  });
});
