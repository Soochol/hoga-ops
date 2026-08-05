import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

// 서버 상태를 흉내 낸다 — 만들기 성공 후 재조회에 새 그룹이 **실제로 등장**해야
// "생성 → 자동으로 종목 추가 팝오버" 경로를 검증할 수 있다(고정 응답이면 새 그룹이
// 영원히 렌더되지 않아 그 경로가 조용히 통과한다).
const { store } = vi.hoisted(() => ({
  store: { folders: [{ id: 'f1', name: '반도체', order: 0 }] as { id: string; name: string; order: number }[] },
}));

// 독립 스토어(ADR-0068): 페이지는 useHeatmap/useCreateHeatmapFolder → /api/heatmap 을 부른다.
vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve({
    folders: store.folders,
    entries: [{ code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }],
  })),
  createHeatmapFolder: vi.fn((name: string) => {
    const folder = { id: 'f2', name, order: 1 };
    store.folders = [...store.folders, folder];
    return Promise.resolve(folder);
  }),
}));
// 팝오버 안의 종목 검색은 별도 API 를 타므로 껍데기로 대체 — 여기서 검증하는 건
// "팝오버가 열렸는가"이지 검색 자체가 아니다(FolderAddButton.test 가 검색을 덮는다).
vi.mock('../capture/SymbolSearch', () => ({ SymbolSearch: () => <div data-testid="symbol-search" /> }));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useQuotes: vi.fn(() => ({ data: { phase: 'open', quotes: [] }, dataUpdatedAt: 0 })),
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

import { Heatmap } from './Heatmap';
import { createHeatmapFolder } from '../api/heatmap';

beforeEach(() => {
  vi.clearAllMocks();
  store.folders = [{ id: 'f1', name: '반도체', order: 0 }];
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>,
  );
}

async function createGroup(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: '＋ 새 그룹' }));
  fireEvent.change(screen.getByPlaceholderText('그룹 이름 입력'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
}

it('＋새 그룹 → 이름 입력 → 만들기 시 createHeatmapFolder 호출', async () => {
  renderPage();
  await createGroup('방산');
  await waitFor(() => expect(createHeatmapFolder).toHaveBeenCalledWith('방산'));
});

// 회귀 가드: 예전엔 빈 그룹이 보드에서 걸러져 만든 직후 화면에서 사라졌고, 종목을 넣는
// 표면(헤더 ＋종목)까지 같이 사라져 추가할 방법이 없었다.
it('만든 그룹이 곧바로 보드에 뜨고, 종목 추가 팝오버가 자동으로 열린다', async () => {
  renderPage();
  await screen.findByText('삼성전자');
  await createGroup('방산');
  expect(await screen.findByTestId('heatmap-folder-name-f2')).toHaveTextContent('방산');
  expect(await screen.findByRole('dialog', { name: '종목 추가' })).toBeInTheDocument();
});

it('팝오버를 닫으면 이후 리렌더에서 되살아나지 않는다', async () => {
  renderPage();
  await createGroup('방산');
  const dialog = await screen.findByRole('dialog', { name: '종목 추가' });
  fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '종목 추가' })).toBeNull());
  // 폴링·입력에 의한 재렌더를 흉내 낸다(검색어는 '방산' 그룹을 남긴다) —
  // autoAddFolderId 를 계속 들고 있으면 여기서 팝오버가 부활한다.
  fireEvent.change(screen.getByTestId('heatmap-search'), { target: { value: '방산' } });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '종목 추가' })).toBeNull());
});
