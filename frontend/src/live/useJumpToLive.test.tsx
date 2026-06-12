import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { useJumpToLive } from './useJumpToLive';
import { useLiveTabsStore } from '../state/liveTabs';
import { useLivePageStore } from '../state/livePage';

// Unified isolation: every jump now creates a persisted tab (module-singleton
// store + localStorage), so each test must reset both stores AND storage —
// otherwise tab/persistence state leaks across tests in file order.
beforeEach(() => {
  localStorage.clear();
  useLiveTabsStore.setState({ tabs: [], activeTabId: null });
  useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
});

function Probe() {
  const jump = useJumpToLive();
  const { pathname } = useLocation();
  return (
    <>
      <button onClick={() => jump('005930')}>jump</button>
      <span data-testid="path">{pathname}</span>
    </>
  );
}

describe('useJumpToLive', () => {
  it('sets activeCode and navigates to /live when elsewhere', async () => {
    render(
      <MemoryRouter initialEntries={['/inventory']}>
        <Probe />
        <Routes><Route path="*" element={null} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('jump'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/live'));
  });

  it('sets activeCode without changing route when already on /live', () => {
    render(
      <MemoryRouter initialEntries={['/live']}>
        <Probe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('jump'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(screen.getByTestId('path').textContent).toBe('/live');
  });

  it('jump sets the active tab code (creating the first tab) instead of only setting activeCode', () => {
    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>,
    });
    result.current('005930');
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(['005930']);
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });
});
