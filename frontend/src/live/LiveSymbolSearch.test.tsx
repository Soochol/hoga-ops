import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveSymbolSearch } from './LiveSymbolSearch';
import { useLivePageStore } from '../state/livePage';
import { useLiveTabsStore } from '../state/liveTabs';
import type { SymbolHit } from '../api/types';

const HIT: SymbolHit = {
  code: '005930', name: '삼성전자', market: 'KOSPI',
  captured_count: 0,
  captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
};
const RECENT_HITS: SymbolHit[] = [
  { ...HIT, code: '000660', name: 'SK하이닉스' },
  { ...HIT, code: '373220', name: 'LG에너지솔루션' },
  { ...HIT, code: '035420', name: 'NAVER' },
  { ...HIT, code: '005380', name: '현대차' },
  { ...HIT, code: '207940', name: '삼성바이오로직스' },
  { ...HIT, code: '068270', name: '셀트리온' },
];

// Faithful to the real contract: filterSymbols('') returns ALL symbols (not
// []), so the mock returns [HIT] for EVERY query — including the empty one.
// This is what lets the empty-Enter guard test below catch the regression.
vi.mock('../capture/useSymbols', () => ({
  useSymbolSearch: () => [HIT],
}));

vi.mock('../api/liveIndices', () => ({
  useLiveIndices: () => ({
    data: [
      { kind: 'index', id: 'KOSPI', label: 'KOSPI', investorScope: 'market' },
      { kind: 'index', id: 'KOSPI200', label: 'KOSPI 200', investorScope: 'none' },
    ],
  }),
}));

function renderSearch() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], { entries: [], next_run_at_ms: 0 });
  return render(
    <QueryClientProvider client={qc}>
      <LiveSymbolSearch />
    </QueryClientProvider>,
  );
}

function openSearchPopover() {
  fireEvent.keyDown(window, { key: '/' });
  return screen.getByRole('combobox');
}

describe('LiveSymbolSearch', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useLivePageStore.setState({ activeCode: null });
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it('opens a centered search popover when "/" is pressed', () => {
    renderSearch();
    expect(screen.queryByRole('dialog', { name: '종목 검색' })).toBeNull();
    fireEvent.keyDown(window, { key: '/' });
    const dialog = screen.getByRole('dialog', { name: '종목 검색' });
    const input = screen.getByPlaceholderText('검색어를 입력해주세요') as HTMLInputElement;
    expect(dialog).toHaveClass('fixed', 'left-1/2', 'top-[12vh]');
    expect(input).toHaveClass('text-sm');
    expect(input).not.toHaveClass('text-[22px]');
    expect(document.activeElement).toBe(input);
  });

  it('selecting a result sets activeCode', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });

  it('stores selected stocks as recent searches in localStorage', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.click(screen.getByText('삼성전자'));
    expect(JSON.parse(localStorage.getItem('hoga.liveSymbolSearch.recent') ?? '[]')).toEqual([
      { code: '005930', name: '삼성전자', market: 'KOSPI' },
    ]);
  });

  it('shows the five most recent selected stocks when "/" focuses an empty search', () => {
    localStorage.setItem('hoga.liveSymbolSearch.recent', JSON.stringify(RECENT_HITS));
    renderSearch();
    fireEvent.keyDown(window, { key: '/' });
    expect(screen.getByRole('dialog', { name: '종목 검색' })).toBeInTheDocument();
    expect(screen.getByText('최근 검색')).toBeInTheDocument();
    expect(screen.getByText('최근 검색')).toHaveClass('text-sm');
    expect(screen.getByRole('option', { name: /SK하이닉스/ })).toHaveClass('text-sm');
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
    expect(screen.getByText('삼성바이오로직스')).toBeInTheDocument();
    expect(screen.queryByText('셀트리온')).toBeNull();
  });

  it('selecting an index result opens an index instrument tab', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: 'kospi' } });
    fireEvent.click(screen.getAllByRole('option')[0]);
    const active = useLiveTabsStore.getState().tabs[0];
    expect(active.instrument).toEqual({ kind: 'index', id: 'KOSPI', label: 'KOSPI' });
    expect(useLivePageStore.getState().activeInstrument).toEqual({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
    });
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('renders index rows with a 지수 badge and without a watchlist heart', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: 'kospi' } });
    expect(screen.getAllByText('지수')).toHaveLength(2);
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '관심 그룹 편집' })).toBeInTheDocument();
  });

  it('clicking a result row heart opens the group picker (v3)', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.click(screen.getByRole('button', { name: '관심 그룹 편집' }));
    expect(screen.getByRole('menu', { name: '내 관심 그룹' })).toBeInTheDocument();
  });

  it('Enter on a focused empty input does not select an arbitrary symbol', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('closes the popover on an outside mousedown', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: '삼성' } });
    expect(screen.getByText('삼성전자')).toBeInTheDocument(); // dropdown open
    fireEvent.mouseDown(document.body);                       // click outside
    expect(screen.queryByText('삼성전자')).toBeNull();         // dropdown closed
  });
});
