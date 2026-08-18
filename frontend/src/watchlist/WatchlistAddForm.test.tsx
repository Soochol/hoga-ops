import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import { WatchlistAddForm } from './WatchlistAddForm';

vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: { onChange: (h: any) => void }) => (
    <button onClick={() => onChange({ code: '005930', name: '삼성전자' })}>pick</button>
  ),
}));

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function watchlistWith(entries: Partial<api.WatchlistEntry>[]): api.WatchlistResponse {
  return {
    folders: [{ id: 'f_a', name: '스윙', order: 0 }],
    entries: entries.map((e) => ({
      code: '000000', name: '', registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: 'f_a', order: 0, ...e,
    })),
    memos: [],
    next_run_at_ms: 0,
  };
}

function seedWatchlist(qc: QueryClient, entries: Partial<api.WatchlistEntry>[]) {
  qc.setQueryData(WATCHLIST_KEY, watchlistWith(entries));
}

/** 빈 워치리스트를 **미리 시드한** 클라이언트.
 *
 *  폼이 중복 검사를 위해 `useWatchlist()` 를 읽으므로, 시드가 없으면 훅이 실제
 *  fetch 를 띄운다 — jsdom 에서 그건 느리고 실패하며, 전체 스위트와 함께 돌릴 때만
 *  waitFor 타임아웃을 넘겨 **이 파일만 간헐 실패**하는 모양이 된다(실측).
 *  시드로 최초 fetch 를 없애고, beforeEach 의 getWatchlist mock 이 **add 성공 후
 *  invalidate 가 부르는 리페치**를 받는다(그건 시드로 막을 수 없다 — mutateAsync 가
 *  onSettled 를 기다리므로, 이게 없으면 onAdded 단언이 네트워크를 기다리다 죽는다). */
function newQc() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seedWatchlist(qc, []);
  return qc;
}

describe('WatchlistAddForm', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(watchlistWith([]));
  });

  it('adds the picked code to the target folder and fires onAdded', async () => {
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
      last_success_date: null } as never);
    const onAdded = vi.fn();
    const qc = newQc();
    render(<WatchlistAddForm folderId="f_a" onAdded={onAdded} />, { wrapper: wrap(qc) });
    fireEvent.click(screen.getByText('pick'));
    fireEvent.click(screen.getByRole('button', { name: /추가/ }));
    // resolveAt 미전달 = 맨 아래(기존 계약) — at 자리에 undefined 가 그대로 간다.
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_a', '005930', undefined));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ code: '005930', name: '삼성전자' }));
  });

  it('calls resolveAt at submit time, not when the form renders or a symbol is picked', async () => {
    // 이 순서가 계약의 전부다: 팝오버가 떠 있는 동안 폴링이 order 를 바꾸므로,
    // 열 때 인덱스를 얼리면 엉뚱한 자리에 삽입된다. 렌더·선택 시점 호출은 곧 그 결함이다.
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const resolveAt = vi.fn(() => 3);
    const qc = newQc();
    render(<WatchlistAddForm folderId="f_a" resolveAt={resolveAt} onAdded={vi.fn()} />,
      { wrapper: wrap(qc) });
    expect(resolveAt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('pick'));
    expect(resolveAt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_a', '005930', 3));
  });

  it('forwards at:0 (맨 위 삽입) instead of dropping it', async () => {
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const qc = newQc();
    render(<WatchlistAddForm folderId="f_a" resolveAt={() => 0} onAdded={vi.fn()} />,
      { wrapper: wrap(qc) });
    fireEvent.click(screen.getByText('pick'));
    fireEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_a', '005930', 0));
  });

  it('blocks a code already in this folder instead of sending a no-op add', async () => {
    // 백엔드 add 는 멱등이라 보내도 조용히 아무 일도 안 일어나고 at 도 무시된다 →
    // 사용자에겐 "지정한 자리에 안 생겼다" 로만 보인다. 그래서 보내지 않고 말해 준다.
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const qc = newQc();
    seedWatchlist(qc, [{ code: '005930', name: '삼성전자' }]);   // 시드를 덮어쓴다
    render(<WatchlistAddForm folderId="f_a" resolveAt={() => 0} onAdded={vi.fn()} />,
      { wrapper: wrap(qc) });
    fireEvent.click(screen.getByText('pick'));
    expect(screen.getByText(/이미 이 그룹에 있습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /추가/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /추가/ }));
    expect(add).not.toHaveBeenCalled();
  });

  it('allows a code that is in a different folder', async () => {
    // 다중 소속(ADR-0070)이 정상이다 — 다른 폴더에 있다고 막으면 그 모델이 깨진다.
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const qc = newQc();
    seedWatchlist(qc, [{ code: '005930', name: '삼성전자', folder_id: 'f_other' }]);
    render(<WatchlistAddForm folderId="f_a" resolveAt={() => 1} onAdded={vi.fn()} />,
      { wrapper: wrap(qc) });
    fireEvent.click(screen.getByText('pick'));
    expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_a', '005930', 1));
  });
});
