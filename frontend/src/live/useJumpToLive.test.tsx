import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { useJumpToLive } from './useJumpToLive';
import { dispositionFromMouseEvent } from './liveActivation';
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
  it('maps Ctrl and Meta mouse events to new-tab disposition', () => {
    expect(dispositionFromMouseEvent({ ctrlKey: false, metaKey: false })).toBe('current-tab');
    expect(dispositionFromMouseEvent({ ctrlKey: true, metaKey: false })).toBe('new-tab');
    expect(dispositionFromMouseEvent({ ctrlKey: false, metaKey: true })).toBe('new-tab');
    expect(dispositionFromMouseEvent({ ctrlKey: true, metaKey: true })).toBe('new-tab');
  });

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

  it('new-tab disposition appends a focused populated tab and preserves the previous tab', () => {
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>,
    });

    result.current('005930', '삼성전자', { disposition: 'new-tab' });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['000660', '005930']);
    expect(tabs[1]).toMatchObject({
      code: '005930',
      label: '삼성전자',
      timeframe: '1m',
      historicalFromDate: null,
    });
    expect(activeTabId).toBe(tabs[1].id);
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });

  it('current-tab disposition keeps replacing the active tab', () => {
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const { result } = renderHook(() => useJumpToLive(), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>,
    });

    result.current('005930', '삼성전자', { disposition: 'current-tab' });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['005930']);
    expect(activeTabId).toBe('tab-a');
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });
});
