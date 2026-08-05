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

  // 보드가 빈 그룹도 렌더하게 되면서(새 그룹 직후 종목을 넣을 표면이 그 카드뿐) 드로어의
  // "빈 그룹은 확인 없이 즉시 삭제" 짝이 페이지에도 실재하는 경로가 됐다. 지울 종목이
  // 없으니 확인은 마찰일 뿐 — 두 표면이 같은 규칙을 쓰는지 여기서 못 박는다.
  it('빈 그룹은 확인 없이 즉시 삭제된다', async () => {
    renderPage();
    await screen.findByText('삼성전자');
    await openDeleteFor('빈그룹');
    await waitFor(() => expect(deleteHeatmapFolder).toHaveBeenCalledWith('f2'));
    expect(screen.queryByRole('dialog', { name: '삭제' })).toBeNull();
  });
});
