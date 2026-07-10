import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { HeatmapResponse } from '../api/heatmap';

// --- fetch 계층만 목킹하고 실제 useHeatmap(react-query) 배선을 검증한다.
//     드로어 변경이 진짜 mutation fn 을 호출하는지(→ /heatmap 페이지 동기화의 근거)까지 확인. ---
const api = vi.hoisted(() => ({
  getHeatmap: vi.fn<() => Promise<HeatmapResponse>>(),
  addToHeatmap: vi.fn(() => Promise.resolve({ code: '', name: '', folder_id: null, order: 0 })),
  addToHeatmapFolder: vi.fn(() => Promise.resolve({ code: '', name: '', folder_id: null, order: 0 })),
  removeFromHeatmap: vi.fn(() => Promise.resolve()),
  createHeatmapFolder: vi.fn(() => Promise.resolve({ id: 'fNew', name: '', order: 9 })),
  renameHeatmapFolder: vi.fn(() => Promise.resolve()),
  deleteHeatmapFolder: vi.fn(() => Promise.resolve()),
  reorderHeatmapFolders: vi.fn(() => Promise.resolve()),
  moveHeatmapEntries: vi.fn(() => Promise.resolve()),
  reorderHeatmapEntries: vi.fn(() => Promise.resolve()),
  removeHeatmapEntries: vi.fn(() => Promise.resolve()),
}));
vi.mock('../api/heatmap', () => api);

// 섹터 랭킹 invalidate 대상 키만 필요 — 실제 fetch 는 안 일어나게 모듈 경량 목.
vi.mock('../api/indexSectorRankings', () => ({ INDEX_SECTOR_RANKINGS_KEY: ['index-sector-rankings'] }));

const onPick = vi.hoisted(() => vi.fn());
vi.mock('../live/useJumpToLive', () => ({ useJumpToLive: () => onPick }));

vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { activeCode: string | null }) => unknown) => sel({ activeCode: '000001' }),
}));

vi.mock('../api/liveQuotes', () => ({
  useQuoteByCode: () => new Map(),
}));

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: { code: string; name: string; market: string }) => void }) =>
    <button data-testid="pick" onClick={() => onChange({ code: '005930', name: '삼성전자', market: 'KOSPI' })}>pick</button>,
}));

import { HeatmapDrawer } from './HeatmapDrawer';

function makeData(): HeatmapResponse {
  return {
    folders: [
      { id: 'f1', name: '2차전지', order: 0 },
      { id: 'f2', name: '반도체', order: 1 },
      { id: 'f3', name: '빈그룹', order: 2 },
    ],
    entries: [
      { code: '000001', name: '에코프로', folder_id: 'f1', order: 0 },
      { code: '000002', name: 'LG엔솔', folder_id: 'f1', order: 1 },
      { code: '000003', name: '삼성전자', folder_id: 'f2', order: 0 },
      { code: '000004', name: '미분류종목', folder_id: null, order: 0 },
    ],
  };
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((fn) => fn.mockClear());
  onPick.mockClear();
  api.getHeatmap.mockResolvedValue(makeData());
});

afterEach(() => cleanup());

describe('HeatmapDrawer', () => {
  it('renders groups with rows; shows an empty real folder but hides empty 미분류', async () => {
    // 미분류 엔트리를 제거해 빈 미분류가 되게 한다.
    api.getHeatmap.mockResolvedValue({
      ...makeData(),
      entries: makeData().entries.filter((e) => e.folder_id !== null),
    });
    wrap(<HeatmapDrawer />);
    expect(await screen.findByRole('button', { name: '2차전지 2' })).toBeInTheDocument();
    // 빈 실폴더(f3)는 표시(＋종목으로 채울 수 있어야 하므로).
    expect(screen.getByRole('button', { name: '빈그룹 0' })).toBeInTheDocument();
    // 빈 미분류는 숨김.
    expect(screen.queryByRole('button', { name: /^미분류/ })).toBeNull();
    expect(screen.getByTestId('heatmap-drawer-row-000001')).toBeInTheDocument();
  });

  it('shows the 미분류 group when it has entries', async () => {
    wrap(<HeatmapDrawer />);
    expect(await screen.findByRole('button', { name: '미분류 1' })).toBeInTheDocument();
    expect(screen.getByTestId('heatmap-drawer-row-000004')).toBeInTheDocument();
  });

  it('row click jumps to the chart via useJumpToLive(code, name)', async () => {
    wrap(<HeatmapDrawer />);
    const row = await screen.findByTestId('heatmap-drawer-row-000001');
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith('000001', '에코프로', expect.anything());
  });

  it('marks the active row via aria-current', async () => {
    wrap(<HeatmapDrawer />);
    // activeCode = '000001' (mocked)
    const row = await screen.findByTestId('heatmap-drawer-row-000001');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('heatmap-drawer-row-000002')).not.toHaveAttribute('aria-current');
  });

  it('Delete key removes the row (removeFromHeatmap)', async () => {
    wrap(<HeatmapDrawer />);
    const row = await screen.findByTestId('heatmap-drawer-row-000001');
    fireEvent.keyDown(row, { key: 'Delete' });
    await waitFor(() => expect(api.removeFromHeatmap).toHaveBeenCalledWith('000001'));
  });

  it('row ⋯ menu removes and moves entries', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    // 행 ⋯ → 컨텍스트 메뉴
    fireEvent.click(screen.getByRole('button', { name: '에코프로 행 메뉴' }));
    fireEvent.click(screen.getByTestId('heatmap-menu-remove'));
    await waitFor(() => expect(api.removeFromHeatmap).toHaveBeenCalledWith('000001'));

    // 다른 행 → 다른 그룹으로 이동(f2)
    fireEvent.click(screen.getByRole('button', { name: 'LG엔솔 행 메뉴' }));
    fireEvent.click(screen.getByTestId('heatmap-menu-move-f2'));
    await waitFor(() =>
      expect(api.moveHeatmapEntries).toHaveBeenCalledWith(['000002'], 'f2'));
  });

  it('header ＋ creates a folder via GroupNameModal', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '2차전지 2' });
    fireEvent.click(screen.getByRole('button', { name: '새 그룹 만들기' }));
    const dialog = screen.getByRole('dialog', { name: '그룹 추가하기' });
    fireEvent.change(within(dialog).getByPlaceholderText('그룹 이름 입력'), { target: { value: '신규' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '추가' }));
    await waitFor(() => expect(api.createHeatmapFolder).toHaveBeenCalledWith('신규'));
  });

  it('group ⋯ renames, deletes (no confirm), and reorders folders', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '반도체 1' });

    // 이름 변경
    fireEvent.click(screen.getByRole('button', { name: '반도체 그룹 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /그룹 이름 변경/ }));
    const dialog = screen.getByRole('dialog', { name: '그룹 이름 변경' });
    fireEvent.change(within(dialog).getByPlaceholderText('그룹 이름 입력'), { target: { value: '반도체2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '변경' }));
    await waitFor(() => expect(api.renameHeatmapFolder).toHaveBeenCalledWith('f2', '반도체2'));

    // 위로 이동 → 전체 ordered ids (f2 를 앞으로)
    fireEvent.click(screen.getByRole('button', { name: '반도체 그룹 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /위로 이동/ }));
    await waitFor(() =>
      expect(api.reorderHeatmapFolders).toHaveBeenCalledWith(['f2', 'f1', 'f3']));

    // 삭제 → confirm 없이 즉시 deleteHeatmapFolder
    fireEvent.click(screen.getByRole('button', { name: '반도체 그룹 메뉴' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /그룹 삭제/ }));
    await waitFor(() => expect(api.deleteHeatmapFolder).toHaveBeenCalledWith('f2'));
  });

  it('header 종목 추가 adds to 미분류 (addToHeatmap)', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '2차전지 2' });
    fireEvent.click(screen.getByTestId('heatmap-header-add'));
    fireEvent.click(screen.getByTestId('pick'));
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(api.addToHeatmap).toHaveBeenCalledWith('005930'));
  });

  it('collapse toggle persists to localStorage', async () => {
    wrap(<HeatmapDrawer />);
    const toggle = await screen.findByRole('button', { name: '2차전지 접기' });
    fireEvent.click(toggle);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('heatmapDrawer.collapsed')!);
      expect(saved.keys).toContain('f1');
    });
    // 접힌 그룹의 행은 사라진다.
    expect(screen.queryByTestId('heatmap-drawer-row-000001')).toBeNull();
  });

  it('shows an empty state when the heatmap has no folders or entries', async () => {
    api.getHeatmap.mockResolvedValue({ folders: [], entries: [] });
    wrap(<HeatmapDrawer />);
    expect(await screen.findByText('히트맵이 비어 있습니다')).toBeInTheDocument();
  });
});
