import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CursorSidebar from '../../src/sidebar/CursorSidebar';

describe('CursorSidebar', () => {
  it('renders three labeled cards', () => {
    render(<CursorSidebar />);
    expect(screen.getByText('10호가')).toBeInTheDocument();
    expect(screen.getByText('거래원')).toBeInTheDocument();
    expect(screen.getByText('체결')).toBeInTheDocument();
  });

  it('renders injected children into the right cards', () => {
    render(
      <CursorSidebar
        orderbook={<span>OB-CONTENT</span>}
        brokers={<span>BR-CONTENT</span>}
        fills={<span>FT-CONTENT</span>}
      />,
    );
    expect(screen.getByText('OB-CONTENT')).toBeInTheDocument();
    expect(screen.getByText('BR-CONTENT')).toBeInTheDocument();
    expect(screen.getByText('FT-CONTENT')).toBeInTheDocument();
  });

  it('CursorSidebarConnected renders without a Volume Profile mode toggle', async () => {
    const { CursorSidebarConnected } = await import('../../src/sidebar/CursorSidebar');
    render(<CursorSidebarConnected />);
    expect(screen.queryByTestId('volume-profile-mode-toggle')).toBeNull();
  });
});
