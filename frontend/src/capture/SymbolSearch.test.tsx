import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SymbolSearch } from './SymbolSearch';
import type { ReactNode } from 'react';
import type { SymbolsAllResponse } from '../api/types';

function W({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const DEFAULT_ENVELOPE: SymbolsAllResponse = {
  symbols: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 14,
      captured_breakdown: { complete: 14, source_partial: 3, client_incomplete: 2 } },
    { code: '005935', name: '삼성전자우', market: 'KOSPI', captured_count: 0,
      captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
  ],
  status: 'fresh',
  fetched_at_ms: 1,
};

function setup(envelope: SymbolsAllResponse = DEFAULT_ENVELOPE) {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true, status: 200, json: async () => envelope,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('SymbolSearch', () => {
  it('renders the input with placeholder', () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    expect(screen.getByPlaceholderText(/종목/i)).toBeTruthy();
  });

  it('shows dropdown rows when input has 2+ chars', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const input = screen.getByPlaceholderText(/종목/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '삼성' } });
    // Wait one tick for useSymbols data.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText('005930')).toBeTruthy();
  });

  it('Q18: shows captured_count (complete-only) as primary; tooltip has breakdown', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const input = screen.getByPlaceholderText(/종목/i);
    fireEvent.change(input, { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    // "14 complete" as the visible primary text
    expect(screen.getByText(/14 complete/)).toBeTruthy();
    // The breakdown tooltip lives on title attribute of the count.
    const countEl = screen.getByText(/14 complete/);
    expect(countEl.getAttribute('title')).toMatch(/Complete 14 · Partial 3 · Incomplete 2/);
  });

  it('Q19: shows cache status indicator next to the input', async () => {
    const qc = setup({
      symbols: [], status: 'loading' as const, fetched_at_ms: null,
    });
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('symbol-cache-status').getAttribute('data-status')).toBe('loading');
  });

  it('calling onChange with the selected hit on row click', async () => {
    const qc = setup();
    const onChange = vi.fn();
    render(<SymbolSearch value={null} onChange={onChange} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ code: '005930' }));
  });

  it('numeric input matches by code prefix', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '00593' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('005935')).toBeTruthy();
  });

  it('Q19: unavailable status switches to code-only banner', async () => {
    const qc = setup({ symbols: [], status: 'unavailable' as const, fetched_at_ms: null });
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/6자리 코드/)).toBeTruthy();
  });

  // BUG-001 regression: when cache is unavailable, the user is told to enter a
  // 6-digit code directly. The Enter key must promote that code to a placeholder
  // SymbolHit so the form can proceed — without this, Start stays disabled
  // forever (the bug observed in /qa).
  it('BUG-001: unavailable + 6-digit + Enter promotes to placeholder SymbolHit', async () => {
    const qc = setup({ symbols: [], status: 'unavailable' as const, fetched_at_ms: null });
    const onChange = vi.fn();
    render(<SymbolSearch value={null} onChange={onChange} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    const input = screen.getByPlaceholderText(/종목/i);
    fireEvent.change(input, { target: { value: '005930' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      code: '005930',
      name: '—',
      market: 'KOSPI',
    }));
  });

  it('BUG-001: unavailable + non-numeric + Enter does NOT promote', async () => {
    const qc = setup({ symbols: [], status: 'unavailable' as const, fetched_at_ms: null });
    const onChange = vi.fn();
    render(<SymbolSearch value={null} onChange={onChange} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    const input = screen.getByPlaceholderText(/종목/i);
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // onChange called with null (clear) on change event is OK, but never with a hit.
    const hitCalls = onChange.mock.calls.filter((c) => c[0] !== null);
    expect(hitCalls).toHaveLength(0);
  });

  it('BUG-001: unavailable + 5-digit (incomplete code) + Enter does NOT promote', async () => {
    const qc = setup({ symbols: [], status: 'unavailable' as const, fetched_at_ms: null });
    const onChange = vi.fn();
    render(<SymbolSearch value={null} onChange={onChange} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    const input = screen.getByPlaceholderText(/종목/i);
    fireEvent.change(input, { target: { value: '00593' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const hitCalls = onChange.mock.calls.filter((c) => c[0] !== null);
    expect(hitCalls).toHaveLength(0);
  });

  // F3 (design review): empty-state dropdown when no matches
  it('shows "검색 결과가 없습니다" empty state when query has no matches', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '잘못된종목명' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/검색 결과가 없습니다/)).toBeTruthy();
  });
});
