import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveSymbolSearch } from './LiveSymbolSearch';
import { useLivePageStore } from '../state/livePage';
import { useWorkspaceStore, type WorkspaceWindow } from '../state/workspace';
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
    useLivePageStore.setState({ activeInstrument: null, activeCode: null });
  });

  it('opens a centered search popover when "/" is pressed', () => {
    renderSearch();
    expect(screen.queryByRole('dialog', { name: '종목 검색' })).toBeNull();
    fireEvent.keyDown(window, { key: '/' });
    const dialog = screen.getByRole('dialog', { name: '종목 검색' });
    const input = screen.getByPlaceholderText('종목명·코드·지수 검색') as HTMLInputElement;
    expect(dialog).toHaveClass('fixed', 'left-1/2', 'top-[12vh]');
    expect(input).toHaveClass('text-base');
    expect(input).not.toHaveClass('text-[22px]');
    expect(document.activeElement).toBe(input);
  });

  it('opens the search popover when the slash search button is clicked', () => {
    renderSearch();
    expect(screen.queryByRole('dialog', { name: '종목 검색' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '종목 검색 열기' }));
    expect(screen.getByRole('dialog', { name: '종목 검색' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('종목명·코드·지수 검색'));
  });

  it('clips the trigger contents and hides the kbd chip in narrow containers', () => {
    // 드로어가 열려 헤더가 좁아지면 트리거가 24px 까지 접힌다 — overflow-hidden 이
    // 없으면 shrink-0 인 / 칩이 버튼 밖으로 흘러 Settings 라벨과 겹친다(2026-08-04 실측).
    renderSearch();
    const trigger = screen.getByRole('button', { name: '종목 검색 열기' });
    expect(trigger).toHaveClass('overflow-hidden');
    // 반쯤 잘린 칩이 남지 않도록 컨테이너 폭 기준으로 칩을 통째로 숨긴다.
    const kbdWrap = trigger.querySelector('kbd')?.parentElement;
    expect(kbdWrap).toHaveClass('[@container(max-width:9rem)]:hidden');
    expect(trigger.parentElement).toHaveClass('[container-type:inline-size]');
  });

  it('renders the search popover in a body portal so app shells cannot clip it', () => {
    renderSearch();
    fireEvent.keyDown(window, { key: '/' });

    expect(screen.getByRole('dialog', { name: '종목 검색' }).parentElement).toBe(document.body);
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
    expect(screen.getByRole('option', { name: /SK하이닉스/ })).toHaveClass('text-base');
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
    expect(screen.getByText('삼성바이오로직스')).toBeInTheDocument();
    expect(screen.queryByText('셀트리온')).toBeNull();
  });

  it('deletes recent history without activating a stock or closing the search', () => {
    localStorage.setItem('hoga.liveSymbolSearch.recent', JSON.stringify([HIT]));
    renderSearch();
    const input = openSearchPopover();
    fireEvent.click(screen.getByRole('button', { name: '삼성전자 최근 검색 삭제' }));
    expect(useLivePageStore.getState().activeCode).toBeNull();
    expect(screen.getByRole('dialog', { name: '종목 검색' })).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText('종목명, 코드 또는 지수를 입력하세요.')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('hoga.liveSymbolSearch.recent')!)).toEqual([]);
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('keeps the active descendant valid after deleting the final highlighted recent row', () => {
    localStorage.setItem('hoga.liveSymbolSearch.recent', JSON.stringify([HIT, RECENT_HITS[0]]));
    renderSearch();
    const input = openSearchPopover();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: 'SK하이닉스 최근 검색 삭제' }));
    const option = screen.getByRole('option', { selected: true });
    expect(input).toHaveAttribute('aria-activedescendant', option.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useLivePageStore.getState().activeCode).toBe(HIT.code);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('does not select while committing IME text: %j', (composition) => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: '삼성' } });
    fireEvent.keyDown(input, { key: 'Enter', ...composition });
    expect(useLivePageStore.getState().activeCode).toBeNull();
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useLivePageStore.getState().activeCode).toBe(HIT.code);
  });

  it('Escape closes only the search and restores the opener focus', () => {
    const backgroundKey = vi.fn();
    window.addEventListener('keydown', backgroundKey);
    try {
      renderSearch();
      const trigger = screen.getByRole('button', { name: '종목 검색 열기' });
      trigger.focus();
      fireEvent.click(trigger);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(trigger).toHaveFocus();
      expect(backgroundKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', backgroundKey);
    }
  });

  it('storage write failure does not interrupt recent deletion or selection', () => {
    localStorage.setItem('hoga.liveSymbolSearch.recent', JSON.stringify([HIT]));
    renderSearch();
    const input = openSearchPopover();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === 'hoga.liveSymbolSearch.recent') throw new DOMException('Unavailable');
    });
    try {
      fireEvent.click(screen.getByRole('button', { name: '삼성전자 최근 검색 삭제' }));
      expect(screen.queryByRole('option')).toBeNull();
      fireEvent.change(input, { target: { value: '삼성' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(useLivePageStore.getState().activeCode).toBe(HIT.code);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it('selecting an index result opens an index instrument in the current view', () => {
    renderSearch();
    const input = openSearchPopover();
    fireEvent.change(input, { target: { value: 'kospi' } });
    fireEvent.click(screen.getAllByRole('option')[0]);
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
    const newGroup = screen.getByRole('textbox', { name: '새 그룹 만들기' });
    fireEvent.mouseDown(newGroup);
    expect(screen.getByRole('dialog', { name: '종목 검색' })).toBeInTheDocument();
    expect(newGroup).toBeInTheDocument();
    expect(useLivePageStore.getState().activeCode).toBeNull();
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


it('search destination follows the activation policy and excludes pinned windows', () => {
  const previous = useWorkspaceStore.getState();
  const windows: WorkspaceWindow[] = [
    { id: 'a', kind: 'book', group: 2, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
    { id: 'b', kind: 'broker', group: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
    { id: 'pin', kind: 'book', group: 3, rect: { x: 0, y: 0, w: 0.5, h: 1 }, pinned: { code: '000660', name: 'SK하이닉스' } },
  ];
  useWorkspaceStore.setState({ windows, zOrder: ['a', 'b', 'pin'] });
  try {
    renderSearch();
    openSearchPopover();
    expect(screen.getByRole('status')).toHaveTextContent('적용 대상: 그룹 2 · 창 2개고정 창 제외');
    act(() => useWorkspaceStore.setState({ windows: windows.map((win) => ({ ...win, pinned: { code: '000660', name: 'SK하이닉스' } })) }));
    expect(screen.getByRole('status')).toHaveTextContent('모든 창이 고정되어 있습니다');
    act(() => useWorkspaceStore.setState({ windows: [], zOrder: [] }));
    expect(screen.getByRole('status')).toHaveTextContent('그룹 1에 적용');
  } finally {
    cleanup();
    useWorkspaceStore.setState(previous);
  }
});
