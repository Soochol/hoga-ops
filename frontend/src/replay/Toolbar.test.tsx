import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import Toolbar from './Toolbar';
import { useTabsStore } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';

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

describe('Toolbar — Timeframe + 90-day validation', () => {
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

  it('shows inline error when range > 90 days and does NOT commit selection', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useToolbarDraftStore.getState().setDraft(id, {
      code: '005930', from: '20260101', to: '20260501', timeframe: '1m',
    });
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: /불러오기|Reload/ }));
    expect(screen.getByText(/최대 90일/)).toBeInTheDocument();
    const sel = useTabsStore.getState().tabs.find((t) => t.id === id)!.selection;
    expect(sel).toBeNull();
  });
});
