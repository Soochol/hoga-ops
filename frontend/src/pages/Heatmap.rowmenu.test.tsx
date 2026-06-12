import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

// 분리된 히트맵 편집(ADR-0068 G3): 행 우클릭 → 삭제·폴더이동. 모두 /api/heatmap 경유.
vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }],
    entries: [{ code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }],
  })),
  removeFromHeatmap: vi.fn(() => Promise.resolve()),
  moveHeatmapEntries: vi.fn(() => Promise.resolve()),
}));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(() => ({
    quoteByCode: new Map([['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }]]),
    phase: 'open', dataUpdatedAt: 0,
  })),
}));
vi.mock('../api/liveStatus', async (orig) => ({
  ...(await orig<typeof import('../api/liveStatus')>()),
  useLiveStatus: vi.fn(() => ({ data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } })),
}));
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));
// 탭 도입(D5): useJumpToLive가 실제 liveTabs를 import → 로드 시 useLivePageStore.subscribe
// 호출. 위 livePage 모킹은 selector만 제공하므로 liveTabs도 모킹해 모듈 로드 crash를 막는다.
const { openOrFocusTab } = vi.hoisted(() => ({ openOrFocusTab: vi.fn() }));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: { openOrFocusTab: typeof openOrFocusTab }) => unknown) => sel({ openOrFocusTab }),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { removeFromHeatmap, moveHeatmapEntries } from '../api/heatmap';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useHeatmapPrefsStore.setState({ sortMode: 'change' });  // 정적 행(드래그 비활성) — 메뉴만 검증
});

it('행 우클릭 → "히트맵에서 제거" → removeFromHeatmap 호출', async () => {
  renderPage();
  fireEvent.contextMenu(await screen.findByTestId('heatmap-row-005930'));
  fireEvent.click(await screen.findByTestId('heatmap-menu-remove'));
  await waitFor(() => expect(removeFromHeatmap).toHaveBeenCalledWith('005930'));
});

it('행 우클릭 → "미분류"로 이동 → moveHeatmapEntries(코드, null) 호출', async () => {
  renderPage();
  fireEvent.contextMenu(await screen.findByTestId('heatmap-row-005930'));
  // 005930 은 f1 소속 → 이동 대상에 미분류(uncat)가 뜬다.
  fireEvent.click(await screen.findByTestId('heatmap-menu-move-uncat'));
  await waitFor(() => expect(moveHeatmapEntries).toHaveBeenCalledWith(['005930'], null));
});
