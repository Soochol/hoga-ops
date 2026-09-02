import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { HeatmapResponse } from '../api/heatmap';

/**
 * 히트맵 드로어의 두 추가 팝오버 — 이미 그 그룹에 있는 종목을 고르면 **말해 준다**.
 *
 * 그전엔 중복 검사가 아예 없었다: 서버 add 가 멱등이라 「추가」를 눌러도 팝오버만 닫히고
 * 아무 일도 안 일어났다.
 *
 * 헤더 경로가 까다로운 축이다 — **그룹 셀렉트가 판정을 바꾼다.** 판정을 캐시하면 그룹을
 * 옮겨도 옛 답이 남고, 하이라이트가 **다른 그룹의 행을 가리킨 채 머문다**.
 */

const api = vi.hoisted(() => ({
  getHeatmap: vi.fn<() => Promise<HeatmapResponse>>(),
  addToHeatmapFolder: vi.fn(() => Promise.resolve({ code: '', name: '', folder_id: 'f1', order: 0 })),
  removeFromHeatmap: vi.fn(() => Promise.resolve()),
  removeFromHeatmapFolder: vi.fn(() => Promise.resolve()),
  createHeatmapFolder: vi.fn(() => Promise.resolve({ id: 'fNew', name: '', order: 9 })),
  renameHeatmapFolder: vi.fn(() => Promise.resolve()),
  deleteHeatmapFolder: vi.fn(() => Promise.resolve()),
  reorderHeatmapFolders: vi.fn(() => Promise.resolve()),
  moveHeatmapEntries: vi.fn(() => Promise.resolve()),
  reorderHeatmapEntries: vi.fn(() => Promise.resolve()),
  removeHeatmapEntries: vi.fn(() => Promise.resolve()),
}));
vi.mock('../api/heatmap', () => api);
vi.mock('../api/indexSectorRankings', () => ({ INDEX_SECTOR_RANKINGS_KEY: ['index-sector-rankings'] }));
vi.mock('../live/useJumpToLive', () => ({ useJumpToLive: () => vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { activeCode: string | null }) => unknown) => sel({ activeCode: null }),
}));
vi.mock('../api/liveQuotes', () => ({
  useQuoteByCode: () => new Map(),
  isStaleLiveQuote: () => false,
}));
vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: { code: string; name: string; market: string }) => void }) =>
    <button data-testid="pick" onClick={() => onChange({ code: '005930', name: '삼성전자', market: 'KOSPI' })}>pick</button>,
}));

import { HeatmapDrawer } from './HeatmapDrawer';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';

// 고르는 종목(005930)이 **f2 에만** 있다 — f1 을 고르면 중복이 아니어야 하므로 셀렉트
// 전환이 판정을 실제로 뒤집는다.
const DATA: HeatmapResponse = {
  capture_markers: {},
  next_run_at_ms: 0,
  folders: [
    { id: 'f1', name: '2차전지', order: 0 },
    { id: 'f2', name: '반도체', order: 1 },
  ],
  entries: [
    { code: '000001', name: '에코프로', folder_id: 'f1', order: 0 },
    { code: '000660', name: 'SK하이닉스', folder_id: 'f2', order: 0 },
    { code: '005930', name: '삼성전자', folder_id: 'f2', order: 1 },
  ],
};

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const flashed = () =>
  Array.from(document.querySelectorAll('.row-flash'))
    .map((el) => el.getAttribute('data-testid'));

describe('HeatmapDrawer — 추가 팝오버의 중복 안내', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    Object.values(api).forEach((fn) => fn.mockClear());
    useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
    api.getHeatmap.mockResolvedValue(DATA);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('⋯ 메뉴 추가에서 중복이면 알리고, 그 그룹의 행을 가리키고, 보내지 않는다', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '반도체 2' });
    fireEvent.click(screen.getByRole('button', { name: '반도체 그룹 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /종목 추가/ }));
    fireEvent.click(screen.getByTestId('pick'));

    expect(await screen.findByText(/이미 이 그룹에 있습니다/)).toBeTruthy();
    await waitFor(() => expect(flashed()).toEqual(['heatmap-drawer-row-005930']));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });

    const addBtn = screen.getByRole('button', { name: '추가' });
    expect(addBtn).toBeDisabled();
    fireEvent.click(addBtn);
    expect(api.addToHeatmapFolder).not.toHaveBeenCalled();
  });

  it('헤더 추가는 **선택한 그룹**으로 판정한다 — 셀렉트를 바꾸면 답도 바뀐다', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '2차전지 1' });
    fireEvent.click(screen.getByTestId('heatmap-header-add'));
    fireEvent.click(screen.getByTestId('pick'));
    // 기본 선택은 첫 그룹(f1) — 거기엔 없다.
    expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull();
    expect(screen.getByRole('button', { name: '추가' })).toBeEnabled();

    fireEvent.change(screen.getByRole('combobox', { name: '추가할 그룹' }), { target: { value: 'f2' } });
    expect(await screen.findByText(/이미 이 그룹에 있습니다/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
    await waitFor(() => expect(flashed()).toEqual(['heatmap-drawer-row-005930']));

    // 되돌리면 배너가 걷히고 추가가 다시 열린다 — 판정을 캐시하면 여기서 굳는다.
    fireEvent.change(screen.getByRole('combobox', { name: '추가할 그룹' }), { target: { value: 'f1' } });
    await waitFor(() => expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull());
    expect(screen.getByRole('button', { name: '추가' })).toBeEnabled();
  });

  it('접힌 그룹을 가리켜야 하면 펼친다', async () => {
    // 접힌 그룹은 행을 렌더하지 않는다 — 펼치지 않으면 하이라이트가 원리적으로 안 보인다.
    localStorage.setItem('heatmapDrawer.collapsed', JSON.stringify({ keys: ['f2'] }));
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '반도체 2' });
    expect(screen.queryByTestId('heatmap-drawer-row-005930')).toBeNull();

    fireEvent.click(screen.getByTestId('heatmap-header-add'));
    fireEvent.click(screen.getByTestId('pick'));
    fireEvent.change(screen.getByRole('combobox', { name: '추가할 그룹' }), { target: { value: 'f2' } });

    const row = await screen.findByTestId('heatmap-drawer-row-005930');
    await waitFor(() => expect(row.className).toContain('row-flash'));
  });

  it('없는 그룹이면 평소대로 추가한다', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '2차전지 1' });
    fireEvent.click(screen.getByRole('button', { name: '2차전지 그룹 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /종목 추가/ }));
    fireEvent.click(screen.getByTestId('pick'));

    expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(api.addToHeatmapFolder).toHaveBeenCalledWith('005930', 'f1'));
  });
});
