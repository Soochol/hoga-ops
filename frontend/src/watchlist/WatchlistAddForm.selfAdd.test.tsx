import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import * as symbolsApi from '../api/symbols';
import { WATCHLIST_KEY } from './watchlistKeys';
import { WatchlistAddForm } from './WatchlistAddForm';

/**
 * **폼이 자기 자신을 중복이라고 고발하면 안 된다.**
 *
 * `useAddMember` 는 낙관적 mutation 이라 요청을 보내는 그 순간 캐시에 행을 넣는데,
 * 중복 판정은 그 캐시에서 매 렌더 파생된다 — 응답을 기다리는 동안 판정이 뒤집혀
 * "이미 이 그룹에 있습니다" 가 떴다. 사용자 신고가 이것이다("엔터를 치는 순간 리스트에
 * 들어가고 … 중복되어서 경고 라벨이 나온다"). 실제 중복 추가는 일어난 적이 없다 —
 * 거짓말을 한 것은 경고뿐이다.
 *
 * `WatchlistAddForm.test.tsx` 와 **파일을 나누는 이유**: 그쪽은 SymbolSearch 를 「pick」
 * 버튼으로 대체해 add 계약(폴더·인덱스·콜백)만 잰다. 여기서 재는 것은 **키보드 경로**라
 * 진짜 SymbolSearch + useCombobox 가 필요하다(두 번째 Enter 가 곧 제출이라는 계약이
 * 그 조합에서만 존재한다). 같은 파일에서 두 mock 체제는 공존할 수 없다 —
 * `WatchlistEntryPane.duplicate.test.tsx` 와 같은 관용구.
 */

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

  it('추가 요청이 날아가는 동안 중복 경고를 띄우지 않는다', async () => {
    // 응답을 붙잡아 둔다 = 느린 네트워크. 낙관 캐시는 이미 행을 넣은 상태다.
    let release: () => void = () => {};
    vi.spyOn(api, 'addMember').mockImplementation(
      () => new Promise((res) => { release = () => res({} as never); }));
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" onAdded={vi.fn()} />, { wrapper: wrap(newQc()) });

    await typeQuery(user);
    await user.keyboard('{Enter}');                                        // 선택
    await user.click(screen.getByRole('button', { name: /종목 추가/ }));   // 추가

    // 요청이 아직 살아 있는 지금이 결함이 보이던 창이다.
    await waitFor(() => expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull());
    await act(async () => { release(); });
  });

  it('두 번째 Enter 가 제출한다 — 한 번만 추가되고 경고도 없다', async () => {
    // 첫 Enter 는 드롭다운 선택(useCombobox 가 preventDefault), 두 번째 Enter 는
    // 브라우저의 암묵적 폼 제출이다. 사용자가 "엔터 치면 들어간다" 로 읽는 경로.
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" onAdded={onAdded} />, { wrapper: wrap(newQc()) });

    const input = await typeQuery(user);
    await user.keyboard('{Enter}');
    expect(add).not.toHaveBeenCalled();          // 선택은 추가가 아니다
    expect(input.value).toBe('삼성전자 005930');

    await user.keyboard('{Enter}');
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ code: '005930', name: '삼성전자' }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/이미 이 그룹에 있습니다/)).toBeNull();
    expect(input.value).toBe('');                 // 폼이 비어 다음 종목을 받을 준비
  });

  it('Enter 연타가 두 번 추가하지 않는다', async () => {
    // 중복 판정을 얼린 대가로 그 가드가 이중 제출을 못 세운다 — `submitting` 이 그 자리를
    // 대신 맡는지 잰다. 응답을 붙잡아 in-flight 창을 열어 두고 Enter 를 더 친다.
    let release: () => void = () => {};
    const add = vi.spyOn(api, 'addMember').mockImplementation(
      () => new Promise((res) => { release = () => res({} as never); }));
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" onAdded={vi.fn()} />, { wrapper: wrap(newQc()) });

    await typeQuery(user);
    await user.keyboard('{Enter}{Enter}{Enter}{Enter}');
    expect(add).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
  });

  it('진짜 중복(이미 그 그룹에 있는 종목)은 그대로 막는다', async () => {
    // 위 완화가 "중복 검사를 없앴다" 로 미끄러지지 않았는지 — 반대 방향의 가드다.
    const seeded = watchlist([{ code: '005930', name: '삼성전자' }]);
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(seeded);
    const add = vi.spyOn(api, 'addMember').mockResolvedValue({} as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(WATCHLIST_KEY, seeded);
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" onAdded={vi.fn()} onDuplicate={vi.fn()} />,
      { wrapper: wrap(qc) });

    await typeQuery(user);
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/이미 이 그룹에 있습니다/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /종목 추가/ })).toHaveProperty('disabled', true);

    await user.keyboard('{Enter}');               // 두 번째 Enter 도 통과하면 안 된다
    expect(add).not.toHaveBeenCalled();
  });

  it('「아래에 표시했습니다」는 그 표시를 실제로 하는 호출부에서만 붙는다', async () => {
    // onDuplicate 미전달 = 가리킬 리스트가 없는 소비처. 그전엔 문구가 무조건 붙어
    // 없는 것을 가리켰다.
    const seeded = watchlist([{ code: '005930', name: '삼성전자' }]);
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(seeded);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(WATCHLIST_KEY, seeded);
    const user = userEvent.setup();
    render(<WatchlistAddForm folderId="f_a" onAdded={vi.fn()} />, { wrapper: wrap(qc) });

    await typeQuery(user);
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/이미 이 그룹에 있습니다/)).toBeTruthy();
    expect(screen.queryByText(/아래에 표시했습니다/)).toBeNull();
  });
});
