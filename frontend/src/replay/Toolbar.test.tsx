import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import Toolbar from './Toolbar';
import { useTabsStore } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';
import { useReplayLayoutStore } from '../state/replayLayout';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderToolbar() {
  const qc = makeClient();
  return render(<Toolbar />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
}

describe('Toolbar — Timeframe + Load', () => {
  beforeEach(() => {
    // Stub network for child queries (StockCombobox / DateRangePicker).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response);
    useTabsStore.getState().reset();
    useToolbarDraftStore.getState().reset();
  });

  it('Reload commits timeframe into selection', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useToolbarDraftStore.getState().setDraft(id, {
      code: '005930', from: '20260512', to: '20260512', timeframe: '5m',
    });
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: /불러오기|Reload/ }));
    const sel = useTabsStore.getState().tabs.find((t) => t.id === id)!.selection;
    expect(sel?.timeframe).toBe('5m');
  });

  it('opens the SettingsModal when the gear button is clicked', () => {
    renderToolbar();
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
  });

  it('Timeframe button auto-commits when a selection already exists', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930', fromDate: '20260512', toDate: '20260512', timeframe: '1m',
    });
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    const sel = useTabsStore.getState().tabs.find((t) => t.id === id)!.selection;
    expect(sel?.timeframe).toBe('5m');
    expect(sel?.code).toBe('005930');
  });

  it('Timeframe button only updates draft when no selection yet', () => {
    const id = useTabsStore.getState().tabs[0].id;
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    const sel = useTabsStore.getState().tabs.find((t) => t.id === id)!.selection;
    expect(sel).toBeNull();
    expect(useToolbarDraftStore.getState().getDraft(id).timeframe).toBe('5m');
  });

  it('commits selection for ranges longer than 90 days (no client-side cap)', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useToolbarDraftStore.getState().setDraft(id, {
      code: '005930', from: '20260101', to: '20260501', timeframe: '1m',
    });
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: /불러오기|Reload/ }));
    const sel = useTabsStore.getState().tabs.find((t) => t.id === id)!.selection;
    expect(sel?.fromDate).toBe('20260101');
    expect(sel?.toDate).toBe('20260501');
  });
});

describe('Toolbar — sidebar toggle', () => {
  beforeEach(() => {
    useReplayLayoutStore.getState().__resetForTests();
    useTabsStore.getState().reset?.();
  });

  it('shows the hide label and aria-expanded=true when sidebar is visible', () => {
    renderToolbar();
    const btn = screen.getByRole('button', { name: '사이드바 숨기기' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveAttribute('aria-controls', 'replay-sidebar');
  });

  it('shows the show label and aria-expanded=false when sidebar is collapsed', () => {
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    renderToolbar();
    const btn = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking the toggle flips the store', () => {
    renderToolbar();
    const btn = screen.getByRole('button', { name: '사이드바 숨기기' });
    fireEvent.click(btn);
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(true);
    // After collapse, the same button rerenders with the new label
    fireEvent.click(screen.getByRole('button', { name: '사이드바 보이기' }));
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(false);
  });
});
