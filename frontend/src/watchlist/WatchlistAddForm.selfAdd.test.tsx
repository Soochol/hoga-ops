import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import * as symbolsApi from '../api/symbols';
import { WATCHLIST_KEY } from './watchlistKeys';
import { WatchlistAddForm } from './WatchlistAddForm';

// Real SymbolSearch/useCombobox coverage for selection, IME and optimistic requests.
const HIT = {
  code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0,
  captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
};

function watchlist(entries: Partial<api.WatchlistEntry>[] = []): api.WatchlistResponse {
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

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** 시드로 최초 fetch 를 없앤다(자매 파일의 `newQc` 와 같은 근거 — 전체 스위트와 함께
 *  돌 때만 waitFor 타임아웃을 넘겨 이 파일만 간헐 실패하는 모양이 된다). */
function newQc() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(WATCHLIST_KEY, watchlist());
  return qc;
}

/** 검색창에 치고 드롭다운이 뜰 때까지 기다린다. */
async function typeQuery(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByPlaceholderText('종목명 또는 6자리 코드');
  await user.click(input);
  await user.type(input, '삼성');
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  return input as HTMLInputElement;
}

describe('WatchlistAddForm — 자기 추가를 중복으로 세지 않는다', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(watchlist());
    vi.spyOn(symbolsApi, 'getAllSymbols').mockResolvedValue({
      symbols: [HIT], status: 'fresh', reason: null, fetched_at_ms: Date.now(),
    } as never);
  });

  it('Enter 한 번으로 추가하고 입력을 비워 포커스를 유지한다', async () => {
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" onAdded={onAdded} />, { wrapper: wrap(newQc()) });
    const input = await typeQuery(user);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ code: HIT.code, name: HIT.name }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull();
    expect(screen.queryByRole('button', { name: /종목 추가/ })).toBeNull();
    await user.keyboard('{Enter}');
    expect(add).toHaveBeenCalledOnce();
  });

  it('느린 낙관적 추가에서 중복 경고 없이 검색·연타를 차단한다', async () => {
    let release!: () => void;
    const add = vi.spyOn(api, 'addMember').mockImplementation(() => new Promise(resolve => { release = () => resolve({} as never); }));
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" />, { wrapper: wrap(newQc()) });
    const input = await typeQuery(user);
    await user.keyboard('{Enter}{Enter}{Enter}');
    await waitFor(() => expect(add).toHaveBeenCalledOnce());
    expect(input).toBeDisabled();
    expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull();
    await act(async () => release());
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    expect(input).toHaveValue('');
  });

  it('한글 조합 Enter로는 추가하지 않고 다음 Enter로 추가한다', async () => {
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" />, { wrapper: wrap(newQc()) });
    const input = await typeQuery(user);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
    expect(add).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(add).toHaveBeenCalledOnce());
  });

  it('이미 있는 결과는 추가됨으로 표시하고 Enter는 건너뛰며 기존 행 보기로 이동 기능을 제공한다', async () => {
    const seeded = watchlist([{ code: HIT.code, name: HIT.name }]);
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(seeded);
    const add = vi.spyOn(api, 'addMember');
    const qc = newQc(); qc.setQueryData(WATCHLIST_KEY, seeded);
    const onDuplicate = vi.fn(), onMoveHere = vi.fn();
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" onDuplicate={onDuplicate} onMoveHere={onMoveHere} />, { wrapper: wrap(qc) });
    await typeQuery(user);
    expect(screen.getByRole('option')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option')).toHaveTextContent('추가됨');
    await user.keyboard('{Enter}');
    expect(add).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '삼성전자 기존 행 보기' }));
    expect(onDuplicate).toHaveBeenCalledWith(HIT.code);
    await user.click(screen.getByRole('button', { name: '그 행을 여기로 이동' }));
    expect(onMoveHere).toHaveBeenCalledWith(HIT.code);
    expect(add).not.toHaveBeenCalled();
  });

  it('추가 실패는 선택을 보존하고 재시도 후 검색을 비운다', async () => {
    const add = vi.spyOn(api, 'addMember').mockRejectedValueOnce(new Error('저장 실패')).mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" />, { wrapper: wrap(newQc()) });
    const input = await typeQuery(user);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('종목을 추가하지 못했습니다. 저장 실패');
    expect(input).toHaveValue('삼성전자 005930');
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByLabelText('종목 추가 안내')).toHaveTextContent('삼성전자 추가됨');
    expect(add).toHaveBeenCalledTimes(2);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it('실행 취소는 현재 그룹의 멤버십만 제거하고 실패한 취소를 재시도한다', async () => {
    const seeded = watchlist([{ code: HIT.code, name: HIT.name, folder_id: 'f_other' }]);
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(seeded);
    vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const remove = vi.spyOn(api, 'removeMember').mockRejectedValueOnce(new Error('취소 실패')).mockResolvedValue(undefined);
    const qc = newQc(); qc.setQueryData(WATCHLIST_KEY, seeded);
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" />, { wrapper: wrap(qc) });
    const input = await typeQuery(user);
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: '실행 취소' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('추가를 취소하지 못했습니다. 취소 실패');
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByLabelText('종목 추가 안내')).toHaveTextContent('삼성전자 추가 취소됨');
    expect(remove).toHaveBeenNthCalledWith(1, 'f_a', HIT.code);
    expect(remove).toHaveBeenNthCalledWith(2, 'f_a', HIT.code);
    expect(qc.getQueryData<api.WatchlistResponse>(WATCHLIST_KEY)?.entries).toEqual(seeded.entries);
    expect(input).toHaveFocus();
  });

  it('그룹 전환 후 이전 그룹의 응답은 새 폼의 검색·실행 취소에 나타나지 않는다', async () => {
    let release!: () => void;
    vi.spyOn(api, 'addMember').mockImplementation(() => new Promise(resolve => { release = () => resolve({} as never); }));
    const onAdded = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<WatchlistAddForm folderId="f_a" onAdded={onAdded} />, { wrapper: wrap(newQc()) });
    await typeQuery(user);
    await user.keyboard('{Enter}');
    rerender(<WatchlistAddForm folderId="f_b" onAdded={onAdded} />);
    await act(async () => release());
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByRole('button', { name: '실행 취소' })).toBeNull();
    expect(screen.queryByLabelText('종목 추가 안내')).toBeNull();
    expect(onAdded).not.toHaveBeenCalled();
  });
});
