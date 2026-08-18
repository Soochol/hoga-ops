import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WatchlistEntryPane } from './WatchlistEntryPane';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const DATA = {
  folders: [{ id: 'f_a', name: '스윙', order: 0 }],
  entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: '20260102', folder_id: 'f_a', order: 0 },
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
  ],
  memos: [],
  next_run_at_ms: 0,
};

describe('WatchlistEntryPane', () => {
  beforeEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows only the selected folder entries (미분류)', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected={null} />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.queryByText('삼성전자')).not.toBeInTheDocument();
  });

  // --- 일괄 제거의 두 범위(P0-2) ---------------------------------------------
  // v3 다중 소속에서 "뺀다" 는 두 가지다. 이전엔 「🗑 삭제」 하나가 **좁게 읽히고 넓게
  // 실행**됐다(그룹 목록 화면인데 `remove_entries` = 전역 제거). 아래가 그 분리 계약이다.
  it('관심 해제는 확인을 거친 뒤에만 전역 제거한다', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const rm = vi.spyOn(api, 'removeEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: '관심 해제' }));

    // 확인 전에는 아무것도 나가지 않는다 — 이게 이 테스트의 본체다.
    expect(await screen.findByRole('dialog', { name: '관심 해제' })).toBeInTheDocument();
    expect(rm).not.toHaveBeenCalled();

    // 확인 모달의 확정 버튼(툴바 버튼과 이름이 같아 dialog 안으로 좁힌다)
    const confirm = screen.getByRole('dialog', { name: '관심 해제' });
    fireEvent.click(within(confirm).getByRole('button', { name: '관심 해제' }));
    await waitFor(() => expect(rm).toHaveBeenCalledWith(['005930']));
  });

  it('이 그룹에서 빼기는 멤버십만 제거한다 — 다른 그룹에도 있으면 확인 없이', async () => {
    // 005930 이 f_a·f_b 둘 다에 있다 → f_a 에서 빼도 관심종목에 남는다(고아 0).
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 0 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    const rmMember = vi.spyOn(api, 'removeMember').mockResolvedValue();
    const rmAll = vi.spyOn(api, 'removeEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: '이 그룹에서 빼기' }));

    await waitFor(() => expect(rmMember).toHaveBeenCalledWith('f_a', '005930'));
    expect(rmAll).not.toHaveBeenCalled();                       // 전역 제거가 아니다
    expect(screen.queryByRole('button', { name: '빼기' })).not.toBeInTheDocument();  // 확인 없음
  });

  it('관심 해제 확인은 다른 그룹에도 있는 종목 수를 말한다', async () => {
    // 005930 은 f_a·f_b 둘 다, 000660 은 f_a 에만 → 둘 다 고르면 "1종목은 다른 그룹에도".
    // 「빼기」와 달리 이 액션은 그것까지 전부 지우므로, 그 차이가 문구에 나와야 한다.
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 1 },
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 0 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByLabelText('000660 선택'));
    fireEvent.click(screen.getByRole('button', { name: '관심 해제' }));

    const confirm = await screen.findByRole('dialog', { name: '관심 해제' });
    expect(within(confirm).getByText(/모든 그룹/)).toBeInTheDocument();
    expect(within(confirm).getByText(/다른 그룹에도 있습니다/)).toBeInTheDocument();
  });

  it('이 그룹에서 빼기도 마지막 소속이면 확인한다 — 관심종목을 떠나기 때문', async () => {
    // DATA 의 005930 은 f_a 에만 있다 → 빼면 서버가 orphan entry 를 prune 한다.
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const rmMember = vi.spyOn(api, 'removeMember').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: '이 그룹에서 빼기' }));

    const confirm = await screen.findByRole('dialog', { name: '빼기' });
    expect(rmMember).not.toHaveBeenCalled();
    expect(within(confirm).getByText(/관심종목에서 빠집니다/)).toBeInTheDocument();

    fireEvent.click(within(confirm).getByRole('button', { name: '빼기' }));
    await waitFor(() => expect(rmMember).toHaveBeenCalledWith('f_a', '005930'));
  });

  it('multi-select move sends codes in VISUAL order, not checkbox-click order', async () => {
    // both in 스윙(f_a): 005930 (order 0) before 000660 (order 1) → visual order 005930, 000660.
    // moving to 장기(f_b) exercises the cross-folder case the 모든 종목 view used to cover.
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 1 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    // v3 이동 = 대상 추가 후 출처 제거(멤버십). add/remove를 각각 스파이.
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const rm = vi.spyOn(api, 'removeMember').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    // check in REVERSE visual order: 000660 (2nd row) then 005930 (1st row)
    fireEvent.click(screen.getByLabelText('000660 선택'));
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '장기' }));
    // visual order is 005930 before 000660 → add/remove codes must follow that order,
    // add into the target(f_b), remove from the source(f_a).
    await waitFor(() => expect(add.mock.calls.map((c) => c[1])).toEqual(['005930', '000660']));
    expect(add.mock.calls.every((c) => c[0] === 'f_b')).toBe(true);
    expect(rm.mock.calls.map((c) => c[1])).toEqual(['005930', '000660']);
    expect(rm.mock.calls.every((c) => c[0] === 'f_a')).toBe(true);
  });

  it('clears the multi-select when the viewed folder changes', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    expect(screen.getByLabelText('005930 선택')).toHaveAttribute('aria-checked', 'true');
    rerender(<WatchlistEntryPane selected="f_b" />);   // switch away …
    rerender(<WatchlistEntryPane selected="f_a" />);   // … and back: the selection must have cleared
    await waitFor(() =>
      expect(screen.getByLabelText('005930 선택')).toHaveAttribute('aria-checked', 'false'));
  });

  it('move-menu dismisses on outside mousedown and on Escape', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected={null} />, { wrapper: wrap(qc) });
    await screen.findByText('SK하이닉스');
    fireEvent.click(screen.getByLabelText('000660 선택'));

    // outside mousedown closes
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    expect(await screen.findByRole('menuitem', { name: '스윙' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '스윙' })).not.toBeInTheDocument());

    // Escape closes
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    expect(await screen.findByRole('menuitem', { name: '스윙' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '스윙' })).not.toBeInTheDocument());
  });

  it('per-row ↻ triggers catch-up and shows a result banner', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const c = vi.spyOn(api, 'catchupNow').mockResolvedValue({ enqueued: ['x'], deduped: [] } as any);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('삼성전자 수집'));
    await waitFor(() => expect(c).toHaveBeenCalledWith('005930'));
    // banner rendered — scope to the banner's unique message text (the loose /삼성전자/
    // also matches the row name, throwing "multiple elements"). See F7 concerns.
    await waitFor(() => expect(screen.getByText(/수집 대기/)).toBeInTheDocument());
  });
  // 선택 상태의 두 축: 시각(개수)과 보조기술(tri-state aria). 파괴적 액션이 툴바에 둘이나
  // 있는데 "몇 개를 지우는지" 가 어디에도 없었고, 부분 선택은 `aria-checked=false` 라
  // "일부 선택" 이 보조기술에 전달되지 않았다.
  it('shows the selection count and reports tri-state on 전체 선택', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 1 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    const all = screen.getByLabelText('전체 선택');
    const count = screen.getByTestId('selection-count');

    // none — 개수는 **자리를 지킨 채** 숨는다(언마운트하면 오른쪽 버튼들이 점프한다).
    expect(all).toHaveAttribute('aria-checked', 'false');
    expect(count).toHaveClass('invisible');

    // some → mixed
    fireEvent.click(screen.getByLabelText('005930 선택'));
    await waitFor(() => expect(all).toHaveAttribute('aria-checked', 'mixed'));
    expect(count).not.toHaveClass('invisible');
    expect(count).toHaveTextContent('1개 선택');

    // all
    fireEvent.click(screen.getByLabelText('000660 선택'));
    await waitFor(() => expect(all).toHaveAttribute('aria-checked', 'true'));
    expect(count).toHaveTextContent('2개 선택');
  });

  it('전체 선택 클릭은 mixed 에서 전부 선택, all 에서 전부 해제', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 1 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    const all = screen.getByLabelText('전체 선택');

    fireEvent.click(all);                                   // none → all
    await waitFor(() => expect(all).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(all);                                   // all → none
    await waitFor(() => expect(all).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(screen.getByLabelText('005930 선택'));   // → mixed
    await waitFor(() => expect(all).toHaveAttribute('aria-checked', 'mixed'));
    fireEvent.click(all);                                   // mixed → all (표준 관례)
    await waitFor(() => expect(all).toHaveAttribute('aria-checked', 'true'));
  });
  // P1-5: 이 pane 은 시세도 등락률도 없는 관리 화면인데 행을 특정할 단서가 이름뿐이었고,
  // `08/14`·`아직 없음` 이 무슨 날짜인지 화면에 설명이 없었다.
  it('lists the code column and labels what the date means', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    const row = await screen.findByTestId('edit-row-005930');

    // 코드는 **행 안에** 있어야 한다 — aria-label 에만 있으면 화면에서 못 읽는다.
    expect(within(row).getByText('005930')).toBeInTheDocument();

    const header = screen.getByTestId('entry-column-header');
    expect(within(header).getByText('종목')).toBeInTheDocument();
    expect(within(header).getByText('코드')).toBeInTheDocument();
    // 「저장」이 아니라 「수집」 — 이 날짜는 Daily Scheduler 캐치업의 마지막 성공일이라
    // 폴더 토글이 가르는 실시간 저장 축과 다르다(↻ 의 aria-label 과 같은 어휘).
    expect(within(header).getByText('마지막 수집')).toBeInTheDocument();

    // 헤더와 행이 **같은 grid 템플릿**을 써야 컬럼이 어긋나지 않는다. 따로 하드코딩하면
    // 한쪽만 고쳤을 때 조용히 틀어지므로 클래스로 못박는다.
    const cols = /grid-cols-\[16px_1fr_7ch_8ch_2\.5ch\]/;
    expect(header.className).toMatch(cols);
    expect(row.className).toMatch(cols);

    // ⚠ 같은 템플릿만으로는 부족하다: 컬럼 폭이 `ch` 단위라 **컨테이너 폰트 크기에 비례**
    // 한다. 헤더 컨테이너에 작은 글씨를 걸면 같은 `7ch` 가 다른 픽셀이 되어 컬럼이 어긋난다
    // (실측으로 코드 컬럼이 헤더 1114 vs 행 1061 로 벌어졌다). 작은 글씨는 자식 span 몫이다.
    // jsdom 은 레이아웃을 계산하지 않아 **좌표로는 못 재므로** 그 원인을 클래스로 막는다.
    expect(header.className).toMatch(/(^|\s)text-sm(\s|$)/);
    expect(header.className).not.toMatch(/(^|\s)text-2xs(\s|$)/);
    expect(within(header).getByText('코드').className).toMatch(/text-2xs/);
  });

  it('hides the column header when the folder is empty', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }],
      entries: [],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('이 그룹에 종목이 없습니다');
    // 빈 그룹에 컬럼 머리글만 떠 있으면 "표가 있는데 비었다" 가 아니라 노이즈다.
    expect(screen.queryByTestId('entry-column-header')).not.toBeInTheDocument();
  });
  // P2-1: 유니코드 글리프(⇄·↻)를 ui/ SVG 프리미티브로 이관했다(ADR-0110 관용구).
  // 회전 애니메이션의 **부착 지점**이 계약이다 — 버튼에 걸면 패딩까지 함께 돈다.
  it('spins the refresh icon, not the button, while catching up', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    // 영원히 pending — catchingUp 상태를 붙잡아 둔다.
    vi.spyOn(api, 'catchupNow').mockReturnValue(new Promise(() => {}) as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    const button = screen.getByLabelText('삼성전자 수집');

    // 문자 글리프가 아니라 SVG 다(폰트별 렌더 불일치·색 토큰 미적용 회피).
    expect(button.querySelector('svg')).not.toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(button.querySelector('svg')).toHaveClass('animate-spin'));
    expect(button.className).not.toMatch(/animate-spin/);
  });
  // prop 을 만든 것과 **호출부가 그걸 넘기는 것**은 다른 축이다. AddForm 자체 테스트는
  // layout 동작만 보므로, 여기서 inline 을 지워도 그쪽은 초록이다(red-check 에서 실측).
  // 이 pane 은 638px 이라 2줄일 이유가 없다 — 실측 폼 높이 37px(2줄이면 79px).
  it('asks the add form for the inline layout — this pane is wide', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');

    const form = container.querySelector('form')!;
    expect(form).toHaveClass('flex');
    expect(form).not.toHaveClass('flex-col');
  });

  // P2-2: 이 문구는 툴바 우측 끝(패널의 정렬 컨트롤과 같은 자리)에 "~순" 어미로 있어
  // 정렬 드롭다운처럼 읽혔지만 클릭해도 아무 일도 없었다. 이 pane 의 순서는 **항상**
  // 직접 설정이므로(드래그 재정렬이 order 인덱스와 맞물린 구조) 상태를 서술한다.
  it('describes the ordering as state, not as a sort control', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');

    expect(screen.getByText(/순서: 직접 설정/)).toBeInTheDocument();
    expect(screen.queryByText('직접 설정한 순')).not.toBeInTheDocument();
    // 컨트롤이 아니다 — 버튼/메뉴로 노출되면 안 된다.
    expect(screen.queryByRole('button', { name: /직접 설정/ })).not.toBeInTheDocument();
  });
});
