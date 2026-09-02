import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { WatchlistDrawer } from './WatchlistDrawer';
import { useLivePageStore } from '../state/livePage';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';

/**
 * 추가 팝오버가 "이미 이 그룹에 있습니다" 를 말할 때 **그 행을 실제로 가리키는가**.
 *
 * 그전까지 드로어의 두 팝오버(그룹 ⋯ 메뉴 · 행 우클릭 삽입)는 `onDuplicate` 를 넘기지
 * 않았다. 그래서 문구의 "— 아래에 표시했습니다" 가 **없는 것을 가리켰다**: 리스트에서는
 * 아무 일도 일어나지 않았다. 편집 모달 우측 pane 만 그 약속을 지키고 있었다.
 *
 * ⋯ 메뉴 경로가 특히 중요하다 — 그룹이 접혀 있으면 하이라이트할 행 자체가 DOM 에 없어서
 * **펼치기까지 해야** 가리킨 것이 된다.
 */

vi.mock('../capture/SymbolSearch', () => ({
  // 이미 f_0000000a 에 있는 종목을 고른다 = 중복.
  SymbolSearch: ({ onChange }: { onChange: (h: unknown) => void }) => (
    <button onClick={() => onChange({ code: '005930', name: '삼성전자' })}>pick</button>
  ),
}));

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const DATA: watchlistApi.WatchlistResponse = {
  folders: [{ id: 'f_0000000a', name: '스윙', order: 0 }],
  entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
  ],
  memos: [],
  next_run_at_ms: 0,
};

function renderPanel() {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc) });
}

describe('WatchlistDrawer — 중복 종목을 리스트에서 가리킨다', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useLivePageStore.setState({ activeInstrument: null, activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    // jsdom 에는 scrollIntoView 가 없다(구현부도 `?.` 로 호출한다).
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('행 우클릭 삽입에서 중복을 고르면 그 행이 하이라이트된다', async () => {
    renderPanel();
    // 앵커는 SK하이닉스, 가리켜질 행은 삼성전자 — 둘이 달라야 "앵커가 우연히 맞았다" 가 아니다.
    const anchor = await screen.findByTestId('watchlist-row-000660');
    expect(screen.getByTestId('watchlist-row-005930').className).not.toContain('row-flash');

    fireEvent.contextMenu(anchor);
    fireEvent.click(await screen.findByText('위에 종목 추가'));
    fireEvent.click(await screen.findByText('pick'));

    await waitFor(() =>
      expect(screen.getByTestId('watchlist-row-005930').className).toContain('row-flash'));
    // 하이라이트만으로는 부족하다 — 그 행이 화면 밖이면 아무것도 안 보인다.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    // 앵커 행은 건드리지 않는다.
    expect(screen.getByTestId('watchlist-row-000660').className).not.toContain('row-flash');
    // 팝오버는 열린 채 남는다 — 닫으면 방금 본 안내까지 사라진다.
    expect(screen.getByTestId('watchlist-group-add-popover')).toBeTruthy();
  });

  it('접힌 그룹의 ⋯ 메뉴에서 중복을 고르면 그룹을 펼쳐서 가리킨다', async () => {
    // 접힌 그룹은 행을 렌더하지 않는다 — 펼치지 않으면 하이라이트가 원리적으로 안 보인다.
    window.localStorage.setItem('watchlist.collapsed', JSON.stringify({ keys: ['f_0000000a'] }));
    renderPanel();
    const menuButton = await screen.findByLabelText('스윙 그룹 메뉴');
    expect(screen.queryByTestId('watchlist-row-005930')).toBeNull();

    fireEvent.click(menuButton);
    fireEvent.click(await screen.findByText('종목 추가'));
    fireEvent.click(await screen.findByText('pick'));

    const row = await screen.findByTestId('watchlist-row-005930');
    await waitFor(() => expect(row.className).toContain('row-flash'));
  });
});
