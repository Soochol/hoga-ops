import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { WatchlistDrawer } from './WatchlistDrawer';
import { useLivePageStore } from '../state/livePage';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';

/**
 * 행 우클릭으로 **자리를 지정해** 종목을 넣는 경로(v5).
 *
 * 여기서 재는 것은 "메뉴가 뜬다" 가 아니라 **어느 인덱스가 요청에 실리는가**다 —
 * 그 숫자가 이 기능의 전부이고, 틀려도 에러 없이 엉뚱한 자리에 조용히 생긴다.
 */

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: unknown) => void }) => (
    <button onClick={() => onChange({ code: '035420', name: '네이버' })}>pick</button>
  ),
}));

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

type Entry = watchlistApi.WatchlistEntry;

const FOLDERS = [{ id: 'f_0000000a', name: '스윙', order: 0 }];
// items: [005930(0), memo(1), 000660(2)] — 메모가 종목 **사이**에 있다.
const ENTRIES: Entry[] = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 2 },
];
const MEMOS: watchlistApi.WatchlistMemo[] = [
  { id: 'm_0000000a', folder_id: 'f_0000000a', order: 1, text: '실적 발표 대기' },
];
const DATA = { folders: FOLDERS, entries: ENTRIES, memos: MEMOS, next_run_at_ms: 0 };

function renderPanel(data = DATA) {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc) });
  return qc;
}

/** 폴링 리페치를 흉내 낸다 — 실제 경로(60초 refetchInterval)와 같은 방식이다.
 *  setQueryData 직접 주입은 뒤이은 리페치가 옛 mock 으로 덮을 수 있어 쓰지 않는다.
 *
 *  ⚠ 이 await 만으로는 부족하다 — 캐시가 바뀌어도 컴포넌트가 새 `data` 로 리렌더되는
 *  데는 한 틱이 더 걸린다(실측: 여기서 바로 제출하면 **옛 order 가 실려** 테스트가
 *  통과해 버린다). 호출부는 화면에서 관찰 가능한 변화를 반드시 기다린다. */
async function serverStateChangesTo(qc: QueryClient, data: watchlistApi.WatchlistResponse) {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(data);
  await act(async () => { await qc.refetchQueries({ queryKey: ['watchlist'] }); });
}

/** 검색 팝오버에서 종목을 고르고 제출한다. */
function pickAndSubmit() {
  fireEvent.click(screen.getByText('pick'));
  fireEvent.click(screen.getByRole('button', { name: /＋ 종목 추가/ }));
}

describe('WatchlistDrawer — 행 우클릭으로 자리 지정 종목 추가', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useLivePageStore.setState({ activeInstrument: null, activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
  });

  it('종목 행 위에 삽입하면 그 행의 items 인덱스가 실린다', async () => {
    const add = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({} as never);
    renderPanel();
    // 000660 은 order 2 (메모가 1 을 차지한다) — entries 배열 인덱스 1 이 아니다.
    fireEvent.contextMenu(await screen.findByTestId('watchlist-row-000660'));
    fireEvent.click(screen.getByTestId('watchlist-menu-add-symbol'));
    pickAndSubmit();
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_0000000a', '035420', 2));
  });

  it('맨 위 행에 삽입하면 at 0 이 실린다 (0 이 falsy 라 잘 사라지는 자리)', async () => {
    const add = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({} as never);
    renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-row-005930'));
    fireEvent.click(screen.getByTestId('watchlist-menu-add-symbol'));
    pickAndSubmit();
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_0000000a', '035420', 0));
  });

  it('빈칸 행 우클릭은 종목 메뉴가 아니라 빈칸 메뉴를 연다', async () => {
    renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-memo-m_0000000a'));
    expect(screen.getByTestId('watchlist-memo-row-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('watchlist-row-menu')).toBeNull();
  });

  it('빈칸을 종목으로 **교체**한다 — 그 자리에 넣고 빈칸을 지운다', async () => {
    const add = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({} as never);
    const removeMemo = vi.spyOn(watchlistApi, 'removeMemo').mockResolvedValue(undefined);
    renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-memo-m_0000000a'));
    fireEvent.click(screen.getByTestId('watchlist-menu-memo-fill-symbol'));
    pickAndSubmit();
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_0000000a', '035420', 1));
    await waitFor(() => expect(removeMemo).toHaveBeenCalledWith('m_0000000a'));
  });

  it('추가가 실패하면 빈칸을 지우지 않는다 — 자리와 내용이 함께 사라지면 되돌릴 근거가 없다', async () => {
    vi.spyOn(watchlistApi, 'addMember').mockRejectedValue(new Error('boom'));
    const removeMemo = vi.spyOn(watchlistApi, 'removeMemo').mockResolvedValue(undefined);
    renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-memo-m_0000000a'));
    fireEvent.click(screen.getByTestId('watchlist-menu-memo-fill-symbol'));
    pickAndSubmit();
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(removeMemo).not.toHaveBeenCalled();
  });

  it('등락률 정렬 그룹에선 삽입 항목이 아예 안 뜬다 — 화면 순서 ≠ 저장 순서', async () => {
    // 드래그·메모 표시가 꺼지는 것과 같은 게이트. "위에" 가 사용자가 본 자리를
    // 가리키지 못하므로 항목을 비활성화가 아니라 **제거**한다.
    window.localStorage.setItem('watchlist.folderSortMode.v1',
      JSON.stringify({ f_0000000a: 'change_pct_desc' }));
    renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-row-005930'));
    expect(screen.getByTestId('watchlist-row-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('watchlist-menu-add-symbol')).toBeNull();
    expect(screen.queryByTestId('watchlist-menu-insert-memo')).toBeNull();
  });

  it('삽입 인덱스는 메뉴를 연 시점이 아니라 **제출 시점**의 순서에서 읽는다', async () => {
    // 팝오버가 떠 있는 동안 60초 폴링이 order 를 바꾼다. 메뉴를 열 때 얼린 숫자를
    // 쓰면 그 사이 위에 행이 하나 늘어난 경우 한 칸 위에 꽂힌다.
    const add = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({} as never);
    const qc = renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-row-000660'));
    fireEvent.click(screen.getByTestId('watchlist-menu-add-symbol'));
    // 팝오버가 열린 뒤 서버 상태가 갱신됐다 — 000660 이 2 → 3 으로 밀렸다.
    await serverStateChangesTo(qc, {
      ...DATA,
      entries: [ENTRIES[0], { ...ENTRIES[1], order: 3 }],
      memos: [MEMOS[0], { id: 'm_0000000b', folder_id: 'f_0000000a', order: 2, text: '추가된 빈칸' }],
    });
    // 새 빈칸이 그려질 때까지 = 컴포넌트가 새 order 를 들고 있을 때까지.
    await waitFor(() => expect(screen.getByTestId('watchlist-memo-m_0000000b')).toBeInTheDocument());
    pickAndSubmit();
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_0000000a', '035420', 3));
  });

  it('앵커 행이 사라졌으면 맨 아래로 떨어뜨린다(undefined) — 실패시키지 않는다', async () => {
    const add = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({} as never);
    const qc = renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-row-000660'));
    fireEvent.click(screen.getByTestId('watchlist-menu-add-symbol'));
    await serverStateChangesTo(qc, { ...DATA, entries: [ENTRIES[0]] });  // 000660 이 없어졌다
    await waitFor(() => expect(screen.queryByTestId('watchlist-row-000660')).toBeNull());
    pickAndSubmit();
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_0000000a', '035420', undefined));
  });
});
