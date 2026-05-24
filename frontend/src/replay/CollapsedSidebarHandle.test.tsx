import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';

import CollapsedSidebarHandle from './CollapsedSidebarHandle';
import { useReplayLayoutStore } from '../state/replayLayout';

beforeEach(() => {
  useReplayLayoutStore.getState().__resetForTests();
  // Pre-collapse for these tests
  useReplayLayoutStore.getState().setSidebarCollapsed(true);
});

describe('CollapsedSidebarHandle', () => {
  it('renders a button with the expand label and aria-expanded=false', () => {
    render(<CollapsedSidebarHandle />);
    const btn = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'replay-sidebar');
  });

  it('clicking expands the sidebar (collapsed → false)', () => {
    render(<CollapsedSidebarHandle />);
    fireEvent.click(screen.getByRole('button', { name: '사이드바 보이기' }));
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(false);
  });
});
