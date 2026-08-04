import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, describe, beforeEach } from 'vitest';

// v3 (ADR-0112) 그룹 삭제 확인의 **페이지 쪽** 계약. 드로어(HeatmapDrawer)와 같은 규칙이지만
// 확인 로직은 두 표면이 각자 갖고 있어(페이지 = onDeleteFolder, 드로어 = deleteFolderWithConfirm)
// 드로어에만 테스트가 있으면 한쪽만 조용히 회귀한다.
//
// 확인 표면은 **앱 내 ConfirmModal** 이다 — window.confirm 이 아니어야 한다. 네이티브
// 다이얼로그는 테마·폰트·색 토큰이 전부 증발하고 종목 수를 강조할 수도 없다.
vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve({
    folders: [
      { id: 'f1', name: '반도체', order: 0 },
      { id: 'f2', name: '빈그룹', order: 1 },
    ],
    entries: [
      { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 },
      { code: '000660', name: 'SK하이닉스', folder_id: 'f1', order: 1 },
    ],
  })),
  deleteHeatmapFolder: vi.fn(() => Promise.resolve()),
}));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(() => ({
    quoteByCode: new Map(), phase: 'open', dataUpdatedAt: 0,
  })),
}));
vi.mock('../live/liveNavigate', () => ({
  activateLiveCode: vi.fn(),
  activateLiveInstrument: vi.fn(),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { deleteHeatmapFolder } from '../api/heatmap';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>,
  );
}

const headerOf = (name: string) =>
  screen.getByText(name).closest('.min-h-list-group-header') as HTMLElement;

/** 그룹 헤더 우클릭 → '그룹 삭제' 까지. 삭제 진입은 이 경로 하나뿐이다. */
async function openDeleteFor(groupName: string) {
  fireEvent.contextMenu(headerOf(groupName));
  fireEvent.click(await screen.findByTestId('heatmap-group-menu-delete'));
}

describe('/heatmap 그룹 삭제 확인', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHeatmapPrefsStore.setState({ sortMode: 'desc' });  // 정적 행 — 메뉴 경로만 검증
  });

  it('멤버 있는 그룹은 ConfirmModal 로 확인하고, 확인 전에는 DELETE 가 안 나간다', async () => {
    renderPage();
    await screen.findByText('삼성전자');
    await openDeleteFor('반도체');

    const dialog = await screen.findByRole('dialog', { name: '삭제' });
    expect(dialog).toHaveTextContent('종목 2개');
    expect(deleteHeatmapFolder).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(deleteHeatmapFolder).toHaveBeenCalledWith('f1'));
  });

  it('확인에서 취소하면 DELETE 가 나가지 않는다', async () => {
    renderPage();
    await screen.findByText('삼성전자');
    await openDeleteFor('반도체');

    const dialog = await screen.findByRole('dialog', { name: '삭제' });
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '삭제' })).toBeNull());
    expect(deleteHeatmapFolder).not.toHaveBeenCalled();
  });

  // 드로어에 있는 "빈 그룹은 확인 없이 즉시 삭제" 짝은 **페이지에 없다**: 보드의
  // `visibleFolderGroups` 가 빈 폴더를 걸러내므로(heat.ts 의 의도적 비대칭 — 드로어는
  // "새 그룹 직후 종목 추가" 흐름 때문에 표시한다) 헤더 자체가 렌더되지 않아 우클릭
  // 메뉴에 도달할 UI 경로가 없다. onDeleteFolder 의 memberCount===0 분기는 드로어와의
  // 대칭·방어용으로 남아 있을 뿐이라 여기서 단언하면 없는 경로를 검증하게 된다.
  it('빈 그룹은 보드에 렌더되지 않아 페이지에서는 삭제 진입 자체가 없다', async () => {
    renderPage();
    await screen.findByText('삼성전자');
    expect(screen.queryByText('빈그룹')).toBeNull();
  });
});
