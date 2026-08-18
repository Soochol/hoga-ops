import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import { mergePanelRows, memosOfFolder, panelRowKey } from './panelRows';
import { useAddMember } from './useWatchlist';

/**
 * `at` 삽입의 **낙관 업데이트**만 잰다(요청 자체는 api 테스트가 본다).
 *
 * ⚠ **표시 순서만 재면 "memos 를 안 밀었다" 를 못 잡는다.** mergePanelRows 는
 * `[...entries, ...memos]` 를 안정 정렬하므로, order 가 겹쳐도 동률 자리에서 entry 가
 * 먼저 와서 결과가 우연히 정답과 같아진다(실측 — 이 파일의 초안이 그래서 green 이었다).
 * 그래서 아래 단언은 순서와 함께 **order 축의 조밀성**(폴더당 0..N-1, 중복 없음)을
 * 본다. 그게 서버 불변식(_reindex)이고, 이어지는 낙관 연산·드래그가 딛는 전제다.
 */

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function entry(code: string, order: number): api.WatchlistEntry {
  return {
    code, name: code, registered_at_kst_date: '20260101',
    last_success_date: null, folder_id: 'f_a', order,
  };
}

/** items = [005930(0), memo m_1(1), 000660(2)] 인 폴더 하나. */
function seed(qc: QueryClient) {
  qc.setQueryData(WATCHLIST_KEY, {
    folders: [{ id: 'f_a', name: '스윙', order: 0 }],
    entries: [entry('005930', 0), entry('000660', 2)],
    memos: [{ id: 'm_1', folder_id: 'f_a', order: 1, text: '구간' }],
    next_run_at_ms: 0,
  } satisfies api.WatchlistResponse);
}

function mergedRows(qc: QueryClient) {
  const data = qc.getQueryData(WATCHLIST_KEY) as api.WatchlistResponse;
  return mergePanelRows(
    data.entries.filter((e) => e.folder_id === 'f_a'),
    memosOfFolder(data.memos, 'f_a'),
  );
}

/** 캐시를 화면이 그리는 한 줄로 — 코드는 코드, 메모는 id. */
function displayOrder(qc: QueryClient): string[] {
  return mergedRows(qc).map(panelRowKey);
}

/** 병합 후 order 값들. 조밀해야 한다 — 겹치면 두 축이 어긋났다는 뜻이다. */
function mergedOrders(qc: QueryClient): number[] {
  return mergedRows(qc).map((r) => (r.kind === 'entry' ? r.entry.order : r.memo.order));
}

describe('useAddMember (at: items 인덱스 삽입)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pushes both entries AND memos down from the insert point', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    let resolve!: () => void;
    vi.spyOn(api, 'addMember').mockReturnValue(
      new Promise((r) => { resolve = () => r({} as api.WatchlistEntry); }));
    const { result } = renderHook(() => useAddMember(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: 'f_a', code: '035420', name: '네이버', at: 1 });
    await waitFor(() => expect(displayOrder(qc)).toEqual(['005930', '035420', 'm_1', '000660']));
    // 이 단언이 본론이다 — 메모를 안 밀면 035420 과 m_1 이 둘 다 1 이 되어 [0,1,1,3].
    expect(mergedOrders(qc)).toEqual([0, 1, 2, 3]);
    resolve();
  });

  it('inserts at the very top when at is 0', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    let resolve!: () => void;
    vi.spyOn(api, 'addMember').mockReturnValue(
      new Promise((r) => { resolve = () => r({} as api.WatchlistEntry); }));
    const { result } = renderHook(() => useAddMember(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: 'f_a', code: '035420', name: '네이버', at: 0 });
    await waitFor(() => expect(displayOrder(qc)).toEqual(['035420', '005930', 'm_1', '000660']));
    expect(mergedOrders(qc)).toEqual([0, 1, 2, 3]);
    resolve();
  });

  it('appends when at is omitted (기존 추가 폼·하트 경로의 회귀 가드)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    let resolve!: () => void;
    vi.spyOn(api, 'addMember').mockReturnValue(
      new Promise((r) => { resolve = () => r({} as api.WatchlistEntry); }));
    const { result } = renderHook(() => useAddMember(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: 'f_a', code: '035420', name: '네이버' });
    await waitFor(() => expect(displayOrder(qc)).toEqual(['005930', 'm_1', '000660', '035420']));
    resolve();
  });

  it('leaves an existing member where it is (서버 add 가 멱등이라 옮기면 되돌아온다)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    let resolve!: () => void;
    vi.spyOn(api, 'addMember').mockReturnValue(
      new Promise((r) => { resolve = () => r({} as api.WatchlistEntry); }));
    const { result } = renderHook(() => useAddMember(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: 'f_a', code: '000660', name: 'SK', at: 0 });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(displayOrder(qc)).toEqual(['005930', 'm_1', '000660']);
    resolve();
  });

  it('rolls back the insert when the request rejects', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    vi.spyOn(api, 'addMember').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAddMember(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: 'f_a', code: '035420', name: '네이버', at: 1 });
    // 롤백은 밀어 둔 메모 order 까지 되돌려야 한다 — ctx.prev 통째 복원이라 함께 온다.
    await waitFor(() => expect(displayOrder(qc)).toEqual(['005930', 'm_1', '000660']));
  });
});
