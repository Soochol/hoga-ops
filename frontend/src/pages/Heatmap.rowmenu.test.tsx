import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

// 분리된 히트맵 편집(ADR-0068 G3): 행 우클릭 → 삭제·폴더이동. 모두 /api/heatmap 경유.
vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve({
    folders: [
      { id: 'f1', name: '반도체', order: 0 },
      { id: 'f2', name: '대형주', order: 1 },
    ],
    entries: [{ code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }],
  })),
  removeFromHeatmapFolder: vi.fn(() => Promise.resolve()),
  moveHeatmapEntries: vi.fn(() => Promise.resolve()),
}));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(() => ({
    quoteByCode: new Map([['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }]]),
    phase: 'open', dataUpdatedAt: 0,
  })),
}));
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));
// 단일 뷰 모델(ADR-0113): 행 클릭은 useJumpToLive → activateLiveCode. liveNavigate를
// 모킹해 실제 스토어 투영 없이 jump 경로를 차단한다.
vi.mock('../live/liveNavigate', () => ({
  activateLiveCode: vi.fn(),
  activateLiveInstrument: vi.fn(),
}));

vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  getWatchlist: vi.fn(() => Promise.resolve({ folders: [{ id: 'w1', name: '관찰', order: 0 }], entries: [], memos: [], next_run_at_ms: 0 })),
  addMember: vi.fn(() => Promise.resolve()),
}));
import { addMember } from '../api/watchlist';
import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { removeFromHeatmapFolder, moveHeatmapEntries } from '../api/heatmap';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useHeatmapPrefsStore.setState({ sortMode: 'desc' });  // 정적 행(드래그 비활성) — 메뉴만 검증
});

// 제거는 **우클릭한 행의 그룹 스코프**다 — 같은 종목이 다른 그룹에도 등록돼 있을 수 있어
// 코드만 보내는 전역 제거(removeFromHeatmap)를 쓰면 보이지 않는 그룹까지 지운다.
it('행 우클릭 → "히트맵에서 제거" → 그 그룹에서만 해제', async () => {
  renderPage();
  fireEvent.contextMenu(await screen.findByTestId('heatmap-row-005930'));
  fireEvent.click(await screen.findByTestId('heatmap-menu-remove'));
  await waitFor(() => expect(removeFromHeatmapFolder).toHaveBeenCalledWith('005930', 'f1'));
});

// 메뉴는 관심종목 패널과 같은 짧은 항목 리스트 — 실폴더를 전부 나열하는 '그룹으로 이동'
// 섹션은 없다(그룹이 수십 개면 메뉴가 화면을 덮었다). 그룹 간 이동은 드래그앤드롭 담당.
it('행 우클릭 메뉴에 그룹 이동 목록이 없다', async () => {
  renderPage();
  fireEvent.contextMenu(await screen.findByTestId('heatmap-row-005930'));
  await screen.findByTestId('heatmap-row-menu');
  expect(screen.queryByTestId('heatmap-menu-move-f1')).toBeNull();
  expect(screen.queryByTestId('heatmap-menu-move-f2')).toBeNull();
  expect(screen.queryByText('그룹으로 이동')).toBeNull();
  // 메뉴 항목은 제거 + 수집 둘뿐(testid 로 단언 — 라벨엔 아이콘 글리프가 섞인다).
  expect(screen.getAllByRole('menuitem').map((b) => b.getAttribute('data-testid')))
    .toEqual(['heatmap-menu-collect', 'heatmap-menu-remove']);
  expect(moveHeatmapEntries).not.toHaveBeenCalled();
});

 it('관심 그룹 추가는 메뉴를 유지하고 히트맵 소속을 변경하지 않는다', async () => {
  renderPage();
  fireEvent.contextMenu(await screen.findByTestId('heatmap-row-005930'));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '관찰' }));
  await waitFor(() => expect(addMember).toHaveBeenCalledWith('w1', '005930', undefined));
  expect(await screen.findByText('삼성전자 → 관찰 추가됨')).toBeInTheDocument();
  expect(screen.getByTestId('heatmap-row-menu')).toBeInTheDocument();
  expect(removeFromHeatmapFolder).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByTestId('heatmap-row-menu')).toBeNull();
});

it('관심 그룹 저장 실패를 안내하고 체크를 복구한다', async () => {
  vi.mocked(addMember).mockRejectedValueOnce(new Error('offline'));
  renderPage();
  fireEvent.contextMenu(await screen.findByTestId('heatmap-row-005930'));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '관찰' }));
  expect(await screen.findByText('저장하지 못했습니다. 다시 시도해 주세요.')).toBeInTheDocument();
  expect(screen.getByRole('menuitemcheckbox', { name: '관찰' })).toHaveAttribute('aria-checked', 'false');
});
