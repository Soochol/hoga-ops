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
});
