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

// 시세 주입 가능한 목. quoteSort 가 isStaleLiveQuote 를 임포트하므로 목에 포함(항상 not-stale).
const quotesHolder = vi.hoisted(() => ({ map: new Map<string, { change_pct: number; price: number; change_won: number }>() }));
vi.mock('../api/liveQuotes', () => ({
  useQuoteByCode: () => quotesHolder.map,
  isStaleLiveQuote: () => false,
}));

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: { code: string; name: string; market: string }) => void }) =>
    <button data-testid="pick" onClick={() => onChange({ code: '005930', name: '삼성전자', market: 'KOSPI' })}>pick</button>,
}));

import { HeatmapDrawer } from './HeatmapDrawer';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';

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
  quotesHolder.map = new Map();
  // 정렬 취향 스토어는 모듈 로드 시 1회 생성돼 localStorage.clear() 로는 안 리셋됨 → 명시 초기화.
  useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  api.getHeatmap.mockResolvedValue(makeData());
});

/** 문서 순서대로 렌더된 종목 행 코드 목록. */
function renderedRowCodes(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="heatmap-drawer-row-"]')).map(
    (el) => (el.getAttribute('data-testid') ?? '').replace('heatmap-drawer-row-', ''),
  );
}

/** 문서 순서대로 렌더된 그룹 라벨(chevron 토글 버튼 aria-label 의 라벨 부분). */
function renderedGroupLabels(): string[] {
  return Array.from(document.querySelectorAll('[aria-label$="접기"], [aria-label$="펼치기"]')).map(
    (el) => (el.getAttribute('aria-label') ?? '').replace(/ (접기|펼치기)$/, ''),
  );
}

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

  // --- 검색 ---
  it('종목명 검색은 매칭 행만 남기고 무매칭 그룹을 숨긴다', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    fireEvent.change(screen.getByTestId('heatmap-drawer-search'), { target: { value: '삼성' } });
    await waitFor(() => expect(renderedRowCodes()).toEqual(['000003']));
    expect(screen.queryByRole('button', { name: '2차전지 2' })).toBeNull();
  });

  it('그룹명 검색은 그 그룹 전체를 보여준다', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    fireEvent.change(screen.getByTestId('heatmap-drawer-search'), { target: { value: '2차전지' } });
    await waitFor(() => expect(renderedRowCodes()).toEqual(['000001', '000002']));
  });

  it('검색 중에는 접힌 그룹도 매칭 행을 펼쳐 보여준다(collapsed 무시)', async () => {
    localStorage.setItem('heatmapDrawer.collapsed', JSON.stringify({ keys: ['f2'] }));
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    // f2 접힘 → 삼성전자 행 숨김
    expect(screen.queryByTestId('heatmap-drawer-row-000003')).toBeNull();
    fireEvent.change(screen.getByTestId('heatmap-drawer-search'), { target: { value: '삼성' } });
    await waitFor(() => expect(screen.getByTestId('heatmap-drawer-row-000003')).toBeInTheDocument());
  });

  it('검색 지우기(✕) 버튼이 필터를 리셋한다', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    fireEvent.change(screen.getByTestId('heatmap-drawer-search'), { target: { value: '삼성' } });
    await waitFor(() => expect(renderedRowCodes()).toEqual(['000003']));
    fireEvent.click(screen.getByRole('button', { name: '검색 지우기' }));
    await waitFor(() => expect(renderedRowCodes().length).toBeGreaterThan(1));
  });

  it('무매칭 검색은 "검색 결과 없음"을 보여준다', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    fireEvent.change(screen.getByTestId('heatmap-drawer-search'), { target: { value: 'zzz없음' } });
    expect(await screen.findByText('검색 결과 없음')).toBeInTheDocument();
  });

  // --- 정렬 (페이지와 heatmapPrefs 공유) ---
  it('행 등락률↓ 토글은 공유 스토어(sortMode)를 갱신하고 그룹 내 행을 재정렬한다', async () => {
    // f1: 에코프로(000001)=+1%, LG엔솔(000002)=+9% → 등락률↓ 이면 000002 먼저.
    quotesHolder.map = new Map([
      ['000001', { change_pct: 1, price: 100, change_won: 1 }],
      ['000002', { change_pct: 9, price: 100, change_won: 9 }],
    ]);
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    // manual(기본): 저장 순서 000001, 000002
    expect(renderedRowCodes().slice(0, 2)).toEqual(['000001', '000002']);
    fireEvent.click(screen.getByRole('button', { name: '행 등락률 내림차순 정렬' }));
    // 페이지 공유의 근거: 스토어가 갱신됨
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('change');
    await waitFor(() => expect(renderedRowCodes().slice(0, 2)).toEqual(['000002', '000001']));
  });

  it('그룹 등락률↓ 토글은 공유 스토어(groupSort)를 갱신하고 그룹을 재정렬한다', async () => {
    // f1 평균 +1, f2 평균 +9 → desc 이면 반도체(f2)가 2차전지(f1)보다 앞.
    quotesHolder.map = new Map([
      ['000001', { change_pct: 1, price: 100, change_won: 1 }],
      ['000002', { change_pct: 1, price: 100, change_won: 1 }],
      ['000003', { change_pct: 9, price: 100, change_won: 9 }],
    ]);
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    expect(renderedGroupLabels().slice(0, 2)).toEqual(['2차전지', '반도체']);
    fireEvent.click(screen.getByRole('button', { name: '그룹을 평균 등락률 높은 순으로' }));
    expect(useHeatmapPrefsStore.getState().groupSort).toBe('desc');
    await waitFor(() => expect(renderedGroupLabels().slice(0, 2)).toEqual(['반도체', '2차전지']));
  });

  it('그룹 정렬 활성 시 ⋯ 위/아래 이동은 비활성', async () => {
    useHeatmapPrefsStore.setState({ groupSort: 'desc' });
    wrap(<HeatmapDrawer />);
    await screen.findByRole('button', { name: '반도체 1' });
    fireEvent.click(screen.getByRole('button', { name: '반도체 그룹 메뉴' }));
    expect(screen.getByRole('menuitem', { name: /위로 이동/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /아래로 이동/ })).toBeDisabled();
  });
});
