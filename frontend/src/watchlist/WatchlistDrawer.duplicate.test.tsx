import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
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

// 고르는 종목을 테스트마다 갈아 끼운다 — 「위에 있는 행을 아래로」와 그 반대를 둘 다
// 재려면 한 픽스처 안에서 서로 다른 코드를 골라야 한다. `vi.hoisted` 는 import 평가보다
// 먼저 돌아 mock 팩토리가 이 객체를 안전하게 닫아 잡는다.
const picked = vi.hoisted(() => ({ hit: { code: '005930', name: '삼성전자' } }));
vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: unknown) => void }) => (
    <button onClick={() => onChange(picked.hit)}>pick</button>
  ),
}));

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const entry = (code: string, name: string, order: number): watchlistApi.WatchlistEntry => ({
  code, name, registered_at_kst_date: '20260101', last_success_date: null,
  folder_id: 'f_0000000a', order,
});

// items 축: [005930(0), 000660(1), 035420(2), 빈칸(3)]. 종목이 셋이라 「위에 있는 행을
// 아래 앵커로」와 그 반대를 **같은 픽스처에서** 잴 수 있고, 끝의 빈칸이 memo 앵커 경로를 준다.
const DATA: watchlistApi.WatchlistResponse = {
  folders: [{ id: 'f_0000000a', name: '스윙', order: 0 }],
  entries: [
    entry('005930', '삼성전자', 0),
    entry('000660', 'SK하이닉스', 1),
    entry('035420', 'NAVER', 2),
  ],
  memos: [{ id: 'm_0000000a', folder_id: 'f_0000000a', order: 3, text: '실적 발표 대기' }],
  next_run_at_ms: 0,
};

function renderPanel(data: watchlistApi.WatchlistResponse = DATA) {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc) });
  return qc;
}

/** 행 우클릭 → 「위에 종목 추가」 → 종목 고르기. 중복이면 이동 버튼이 뜬다. */
async function openInsertAndPick(anchorTestId: string) {
  fireEvent.contextMenu(await screen.findByTestId(anchorTestId));
  fireEvent.click(await screen.findByText('위에 종목 추가'));
  fireEvent.click(await screen.findByText('pick'));
}

/** 화면에 그려진 종목 행 순서 — 앵커 아래 두 행만 봐도 이동 여부가 갈린다. */
const rowOrderInDom = () =>
  [...document.querySelectorAll('[data-testid^="watchlist-row-"]')]
    .map((r) => r.getAttribute('data-testid')!.replace('watchlist-row-', ''))
    .filter((c) => c === '005930' || c === '035420');

/** `reorderItems` 에 실린 순서를 읽기 쉬운 키 배열로. */
const orderOf = (spy: ReturnType<typeof vi.spyOn>) =>
  (spy.mock.calls[0][1] as watchlistApi.WatchlistItemRef[])
    .map((it) => (it.kind === 'code' ? it.code : it.id));

describe('WatchlistDrawer — 중복 종목을 리스트에서 가리킨다', () => {
  beforeEach(() => {
    cleanup();
    picked.hit = { code: '005930', name: '삼성전자' };
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

describe('WatchlistDrawer — 「그 행을 여기로 이동」', () => {
  beforeEach(() => {
    cleanup();
    picked.hit = { code: '005930', name: '삼성전자' };
    window.localStorage.clear();
    useLivePageStore.setState({ activeInstrument: null, activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('위에 있던 행을 아래 앵커로 옮기면 **앵커 바로 위**에 들어간다', async () => {
    // ⚠ 이 파일에서 가장 중요한 단언이다. 드래그의 splice 공식(먼저 빼고 원래 인덱스에
    // 끼우기)을 그대로 쓰면 앵커가 한 칸 당겨져 **아래**로 들어간다 — 「위에 종목 추가」로
    // 연 팝오버라 방향이 뒤집히면 그대로 오답인데, 개수도 집합도 같아서 눈에 안 띈다.
    const reorder = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue(undefined);
    renderPanel();
    await openInsertAndPick('watchlist-row-035420');          // 앵커 = NAVER(2)

    fireEvent.click(await screen.findByText('그 행을 여기로 이동'));

    await waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
    expect(orderOf(reorder)).toEqual(['000660', '005930', '035420', 'm_0000000a']);
  });

  it('아래에 있던 행을 위 앵커로 옮기면 같은 규칙이 반대 방향에도 적용된다', async () => {
    const reorder = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue(undefined);
    picked.hit = { code: '035420', name: 'NAVER' };           // 옮길 행 = NAVER(2)
    renderPanel();
    await openInsertAndPick('watchlist-row-000660');          // 앵커 = SK하이닉스(1)

    fireEvent.click(await screen.findByText('그 행을 여기로 이동'));

    await waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
    expect(orderOf(reorder)).toEqual(['005930', '035420', '000660', 'm_0000000a']);
  });

  it('앵커가 그 사이 사라졌으면 맨 아래로 — 추가 경로의 클램프와 같은 답', async () => {
    const reorder = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue(undefined);
    const qc = renderPanel();
    await openInsertAndPick('watchlist-row-035420');
    // 팝오버가 떠 있는 동안 폴링이 앵커 행을 걷어 간다(실제 경로와 같은 방식).
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      ...DATA, entries: DATA.entries.filter((e) => e.code !== '035420'),
    });
    await act(async () => { await qc.refetchQueries({ queryKey: ['watchlist'] }); });
    await waitFor(() => expect(screen.queryByTestId('watchlist-row-035420')).toBeNull());

    fireEvent.click(screen.getByText('그 행을 여기로 이동'));

    await waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
    expect(orderOf(reorder)).toEqual(['000660', 'm_0000000a', '005930']);
  });

  it('빈칸 앵커는 그 자리로 옮기고 **그 뒤에** 빈칸을 지운다 = 교체', async () => {
    const reorder = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue(undefined);
    const removeMemo = vi.spyOn(watchlistApi, 'removeMemo').mockResolvedValue(undefined);
    renderPanel();
    fireEvent.contextMenu(await screen.findByTestId('watchlist-memo-m_0000000a'));
    fireEvent.click(await screen.findByText('여기에 종목 넣기'));
    fireEvent.click(await screen.findByText('pick'));

    fireEvent.click(await screen.findByText('그 행을 여기로 이동'));

    await waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
    // 005930 이 빈칸이 있던 자리로 간다. 빈칸은 그 **뒤에** 지운다 — 먼저 지우면
    // 재정렬이 실패했을 때 자리도 내용도 사라진다.
    expect(orderOf(reorder)).toEqual(['000660', '035420', '005930', 'm_0000000a']);
    await waitFor(() => expect(removeMemo).toHaveBeenCalledWith('m_0000000a'));
  });

  it('앵커가 옮길 행 자신이면 재정렬하지 않고 가리키기만 한다', async () => {
    const reorder = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue(undefined);
    renderPanel();
    await openInsertAndPick('watchlist-row-005930');          // 앵커 = 옮길 행 자신

    fireEvent.click(await screen.findByText('그 행을 여기로 이동'));

    await waitFor(() =>
      expect(screen.getByTestId('watchlist-row-005930').className).toContain('row-flash'));
    expect(reorder).not.toHaveBeenCalled();
  });

  it('이동한 뒤 새 자리로 스크롤한다 — 옮기기 전 자리가 아니라', async () => {
    // 재정렬은 낙관 갱신이라 flash 를 거는 시점의 캐시는 **아직 옛 순서**다. 그 한 번으로
    // 끝내면 옮기기 전 자리로 스크롤한다 — 46행짜리 그룹에서 그건 엉뚱한 곳이다.
    //
    // ⚠ 응답을 **붙잡아야** 잴 수 있다. 즉시 resolve 시키면 `onSettled` 의 invalidate 가
    // 곧바로 원본 픽스처를 다시 실어 와 낙관 순서를 덮고, 그 두 갱신이 한 렌더로 묶여
    // 효과가 새 순서를 **한 번도 못 본다**(실측: 스크롤 0회).
    let release: () => void = () => {};
    vi.spyOn(watchlistApi, 'reorderItems').mockImplementation(
      () => new Promise((res) => { release = () => res(undefined); }));
    renderPanel();
    await openInsertAndPick('watchlist-row-035420');
    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    scrollSpy.mockClear();

    fireEvent.click(await screen.findByText('그 행을 여기로 이동'));

    // 낙관 재정렬이 화면에 앉을 때까지 기다린다 — 그 순서가 곧 스크롤 대상이다.
    await waitFor(() => expect(rowOrderInDom()).toEqual(['005930', '035420']));
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(0);
    await act(async () => { release(); });
  });
});
