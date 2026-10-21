import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SymbolSearch } from './SymbolSearch';
import * as symbolsApi from '../api/symbols';
import { useState, type ReactNode } from 'react';
import type { SymbolsAllResponse } from '../api/types';

function W({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const DEFAULT_ENVELOPE: SymbolsAllResponse = {
  symbols: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 14,
      captured_breakdown: { complete: 14, source_partial: 3, client_incomplete: 2, invalid: 0 } },
    { code: '005935', name: '삼성전자우', market: 'KOSPI', captured_count: 0,
      captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
  ],
  status: 'fresh',
  fetched_at_ms: 1,
};

function setup(envelope: SymbolsAllResponse = DEFAULT_ENVELOPE) {
  vi.spyOn(globalThis, 'fetch' as const).mockResolvedValue({
    ok: true, status: 200, json: async () => envelope,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('SymbolSearch', () => {
  it('선택된 검색어를 새 검색어로 바꿀 때 첫 입력을 지우지 않는다', async () => {
    const qc = setup();
    function Form() {
      const [value, setValue] = useState<typeof DEFAULT_ENVELOPE.symbols[number] | null>(DEFAULT_ENVELOPE.symbols[0]);
      return <SymbolSearch value={value} onChange={setValue} />;
    }
    render(<Form />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '삼성전자우' } });
    expect(input).toHaveValue('삼성전자우');
    expect(await screen.findByRole('option')).toHaveTextContent('005935');
  });

  it('추가된 결과는 표시하되 클릭·Enter로 다시 선택하지 않고 다음 결과를 선택한다', async () => {
    const qc = setup();
    const onChange = vi.fn();
    render(<SymbolSearch value={null} onChange={onChange} optionState={hit => hit.code === '005930' ? 'added' : undefined} />,
      { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const input = screen.getByPlaceholderText(/종목/i);
    fireEvent.change(input, { target: { value: '삼성' } });
    const added = (await screen.findByText('005930')).closest('[role="option"]')!;
    expect(added).toHaveAttribute('aria-disabled', 'true');
    expect(added).toHaveTextContent('추가됨');
    onChange.mockClear();
    fireEvent.click(added);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ code: '005935' }));
  });

  it('resetKey는 value가 null인 채로도 검색어를 비우고 disabled는 선택을 막는다', async () => {
    const qc = setup();
    const onChange = vi.fn();
    const { rerender } = render(<SymbolSearch value={null} onChange={onChange} resetKey={0} />,
      { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const input = screen.getByPlaceholderText(/종목/i);
    fireEvent.change(input, { target: { value: '삼성' } });
    await screen.findByText('005930');
    rerender(<SymbolSearch value={null} onChange={onChange} resetKey={1} disabled />);
    expect(input).toHaveValue('');
    expect(input).toBeDisabled();
  });
  it('집계 중에도 선택할 수 있고 미확인 건수를 완결 없음으로 표시하지 않는다', async () => {
    const qc = setup({ ...DEFAULT_ENVELOPE, capture_counts_status: 'pending',
      symbols: [{ ...DEFAULT_ENVELOPE.symbols[1], capture_counts_status: 'pending' }] });
    const onChange = vi.fn();
    render(<SymbolSearch value={null} onChange={onChange} />,
      { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    expect(await screen.findByText('집계 중')).toBeTruthy();
    expect(screen.queryByText('완결 없음')).toBeNull();
    fireEvent.click(screen.getByText('삼성전자우'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ code: '005935' }));
  });

  it('집계 실패는 종목 목록 갱신 없이 건수만 재시도한다', async () => {
    const failed: SymbolsAllResponse = { ...DEFAULT_ENVELOPE, capture_counts_status: 'failed',
      symbols: [{ ...DEFAULT_ENVELOPE.symbols[1], capture_counts_status: 'failed' }] };
    let retried = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith('/capture-counts/refresh')) {
        retried = true;
        return { ok: true, status: 200, json: async () => ({ status: 'pending' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => retried
        ? { ...failed, capture_counts_status: 'pending',
          symbols: failed.symbols.map((hit) => ({ ...hit, capture_counts_status: 'pending' })) }
        : failed } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<SymbolSearch value={null} onChange={() => {}} />,
      { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    expect(await screen.findByText('집계 실패')).toBeTruthy();
    expect(screen.queryByText('완결 없음')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '집계 재시도' }));
    expect(await screen.findByText('집계 중')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/capture-counts/refresh')))
      .toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/symbols/refresh'))).toBe(false);
  });

  it('집계 재시도 요청의 네트워크 실패를 표시하고 검색을 유지한다', async () => {
    const qc = setup({ ...DEFAULT_ENVELOPE, capture_counts_status: 'failed' });
    render(<SymbolSearch value={null} onChange={() => {}} />,
      { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const retry = await screen.findByRole('button', { name: '집계 재시도' });
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(retry);
    expect(await screen.findByText('재시도 요청에 실패했습니다.')).toBeTruthy();
    expect(screen.getByPlaceholderText(/종목/i)).toBeEnabled();
  });

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
    // "완결 14일" as the visible primary text
    expect(screen.getByText(/완결 14일/)).toBeTruthy();
    // The breakdown tooltip lives on title attribute of the count.
    const countEl = screen.getByText(/완결 14일/);
    expect(countEl.getAttribute('title')).toMatch(/완결 14 · 부분 3 · 미완결 2/);
  });

  // Q19(개정): 상태 뱃지는 **경고일 때만** 뜬다. 정상(fresh)·첫 fetch 중(loading)은
  // 사용자가 할 일이 없는 상태라 상시 표시가 장식이었다 — 검색창 옆의 정체불명한 초록
  // 점이 그것이다. 남기는 둘은 문자 글리프(⏱·!)가 아니라 **텍스트**다(무슨 뜻인지
  // 말해 주고, 폰트별 렌더 불일치도 없다).
  it('Q19: 캐시 상태 뱃지는 경고 상태에서만, 텍스트로 뜬다', async () => {
    const quiet = ['loading', 'fresh'] as const;
    for (const status of quiet) {
      const qc = setup({ symbols: [], status, fetched_at_ms: null });
      const { unmount } = render(<SymbolSearch value={null} onChange={() => {}} />,
        { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
      await new Promise((r) => setTimeout(r, 30));
      expect(screen.queryByTestId('symbol-cache-status')).toBeNull();
      unmount();
    }

    const loud = [['stale', '오래됨'], ['unavailable', '사용 불가']] as const;
    for (const [status, label] of loud) {
      const qc = setup({ symbols: [], status, fetched_at_ms: null });
      const { unmount } = render(<SymbolSearch value={null} onChange={() => {}} />,
        { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
      await new Promise((r) => setTimeout(r, 30));
      const badge = screen.getByTestId('symbol-cache-status');
      expect(badge.getAttribute('data-status')).toBe(status);
      expect(badge).toHaveTextContent(label);
      unmount();
    }
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

describe('SymbolSearch reason-aware empty state', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  function wrapWithData(ui: ReactNode, initialData: unknown) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['symbols', 'all'], initialData);
    return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
  }

  it('shows master_fetch_failed hint when reason is set', () => {
    // master_fetch_failed is a reason the symbols backend actually emits
    // (the previous trading_days_unavailable mock was an impossible state for
    // this surface — symbols.py never sets it — so the reachable hint copy
    // was rendered by no test).
    render(wrapWithData(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [], status: 'unavailable', fetched_at_ms: null, reason: 'master_fetch_failed' },
    ));
    expect(screen.getByText(/키움 종목 목록을 가져오지 못했습니다/)).toBeTruthy();
  });

  it('shows Refresh button when status is unavailable', () => {
    render(wrapWithData(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [], status: 'unavailable', fetched_at_ms: null, reason: 'master_fetch_failed' },
    ));
    expect(screen.getByRole('button', { name: '갱신' })).toBeTruthy();
  });

  it('does NOT show Refresh button when status is fresh', () => {
    render(wrapWithData(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0, captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } }],
        status: 'fresh', fetched_at_ms: 0 },
    ));
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });

  it('falls back to default empty-state copy when reason is null', () => {
    render(wrapWithData(
      <SymbolSearch value={null} onChange={() => {}} />,
      { symbols: [], status: 'unavailable', fetched_at_ms: null, reason: null },
    ));
    expect(screen.getByText(/종목 목록 미가용/)).toBeTruthy();
  });
});

describe('SymbolSearch — empty-result staleness nudge', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  function wrapWithData(ui: ReactNode, initialData: unknown) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['symbols', 'all'], initialData);
    return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
  }

  it('refreshes an old catalog directly when search has no hits', async () => {
    setup();
    const refresh = vi.spyOn(symbolsApi, 'refreshSymbols').mockResolvedValue({ symbols: [], status: 'fresh', fetched_at_ms: Date.now(), reason: null });
    const TEN_DAYS_AGO = Date.now() - 10 * 24 * 60 * 60 * 1000;
    render(wrapWithData(
      <SymbolSearch value={null} onChange={() => {}} />,
      {
        symbols: [
          {
            code: '005930',
            name: '삼성전자',
            market: 'KOSPI',
            captured_count: 0,
            captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
          },
        ],
        status: 'fresh',
        fetched_at_ms: TEN_DAYS_AGO,
        reason: null,
      },
    ));
    const input = screen.getByPlaceholderText(/종목명/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nonexistent-name' } });

    expect(screen.getByText(/검색 결과가 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/Symbol Master.*업데이트되었습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '종목 목록 갱신' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it('does NOT render nudge when catalog is younger than 7 days', () => {
    const ONE_DAY_AGO = Date.now() - 24 * 60 * 60 * 1000;
    render(wrapWithData(
      <SymbolSearch value={null} onChange={() => {}} />,
      {
        symbols: [
          {
            code: '005930',
            name: '삼성전자',
            market: 'KOSPI',
            captured_count: 0,
            captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
          },
        ],
        status: 'fresh',
        fetched_at_ms: ONE_DAY_AGO,
        reason: null,
      },
    ));
    const input = screen.getByPlaceholderText(/종목명/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nonexistent-name' } });

    expect(screen.getByText(/검색 결과가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/Symbol Master.*업데이트되었습니다/)).not.toBeInTheDocument();
  });

  it('종목명이 좁은 컨테이너에서 세로로 깨지지 않는다 — nowrap + 전체 이름 title', async () => {
    // 이 행은 `grid-cols-[1fr_auto_auto_auto]` 이고 종목명만 `1fr` 이라, 좁은
    // 컨테이너(280px 팝오버)에서 그 컬럼이 min-content 로 붕괴한다. **한글의
    // min-content 는 한 글자**라 이름이 세로로 쌓이고 행 높이가 3배가 됐다
    // (실측 11px 폭 / 91px 높이). 영문은 단어가 안 끊겨 이 실패가 안 난다.
    //
    // ⚠ jsdom 은 레이아웃을 계산하지 않아 **줄바꿈 자체는 여기서 못 잰다**. 이
    // 단언이 고정하는 것은 "그 줄바꿈을 정의상 불가능하게 만드는 클래스가 붙어
    // 있는가" 와 "잘린 이름을 복구할 수단이 있는가" 두 가지다. 실제 폭·높이는
    // 도그푸딩으로 확인했다(262px 드롭다운 / 92px 이름 컬럼 / 35px 행).
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    const name = screen.getByText('삼성전자');
    expect(name.className).toContain('truncate');   // = overflow-hidden + ellipsis + nowrap
    expect(name.className).toContain('min-w-0');    // grid 자식이 1fr 아래로 줄 수 있게
    expect(name.getAttribute('title')).toBe('삼성전자');
  });
  // `showRefresh` 는 stale·unavailable 둘 다 포함하는데 갱신 블록이 unavailable 일 때만
  // 렌더돼서 **stale 에서 그 조건이 죽어 있었다** — "오래됨" 을 본 사용자에게 갱신 경로가
  // 없었다. hint 는 unavailable 전용 문구라(목록이 없다는 뜻) stale 에는 붙이지 않는다.
  it('offers 갱신 on stale too — hint stays unavailable-only', async () => {
    const qc = setup({ symbols: [], status: 'stale' as const, fetched_at_ms: null });
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.getByRole('button', { name: '갱신' })).toBeInTheDocument();
    expect(screen.queryByText(/종목 목록 미가용/)).not.toBeInTheDocument();
  });

  it('keeps hint + 갱신 together when the master is unavailable', async () => {
    const qc = setup({ symbols: [], status: 'unavailable' as const, fetched_at_ms: null });
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.getByRole('button', { name: '갱신' })).toBeInTheDocument();
    expect(screen.getByText(/6자리 코드/)).toBeInTheDocument();
  });

  it('shows no 갱신 while fresh', async () => {
    const qc = setup({ symbols: [], status: 'fresh' as const, fetched_at_ms: null });
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.queryByRole('button', { name: '갱신' })).not.toBeInTheDocument();
  });
});
