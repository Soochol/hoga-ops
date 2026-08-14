import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import * as api from '../api/watchlist';
import { useReorderItems, useAddMember, useReorderEntries } from './useWatchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import type { WatchlistResponse } from '../api/watchlist';

/**
 * 낙관적 업데이트의 order 축 회귀 — v4 에서 entries 와 memos 는 **한 축**(폴더 items
 * 인덱스)을 공유한다. 한쪽만 갱신하면 두 축이 어긋나 병합 정렬에서 행이 겹치거나
 * 자리를 바꾼다. 서버 응답이 오기 전 한 프레임 동안 나타나는 증상이라 눈으로는
 * 잡히지 않는다 — 그래서 캐시 값을 직접 잰다.
 */
function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

// items: [code 005930(0), memo(1), code 000660(2)]
const seeded: WatchlistResponse = {
  folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: true }],
  entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 2 },
  ],
  memos: [{ id: 'm_00000001', folder_id: 'f_a', order: 1, text: '실적 발표 대기' }],
  next_run_at_ms: 0,
};

function seededClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(WATCHLIST_KEY, seeded);
  return qc;
}

describe('applyItemsReorder (패널 dnd 낙관 경로)', () => {
  it('entries 와 memos 를 같은 rank 맵으로 갱신한다', async () => {
    vi.spyOn(api, 'reorderItems').mockImplementation(() => new Promise(() => {}));  // pending 유지
    const qc = seededClient();
    const { result } = renderHook(() => useReorderItems(), { wrapper: wrap(qc) });

    // 메모를 맨 앞으로 끌기 → [memo, 000660, 005930]
    act(() => {
      result.current.mutate({
        folderId: 'f_a',
        orderedItems: [
          { kind: 'memo', id: 'm_00000001' },
          { kind: 'code', code: '000660' },
          { kind: 'code', code: '005930' },
        ],
      });
    });

    await waitFor(() => {
      const d = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY)!;
      expect(d.memos[0].order).toBe(0);
    });
    const d = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY)!;
    const byKey = [
      ...d.entries.map((e) => ({ key: e.code, order: e.order })),
      ...d.memos.map((m) => ({ key: m.id, order: m.order })),
    ].sort((a, b) => a.order - b.order);
    expect(byKey.map((r) => r.key)).toEqual(['m_00000001', '000660', '005930']);
    // 축이 0..N-1 로 조밀해야 병합 정렬이 안정적이다
    expect(byKey.map((r) => r.order)).toEqual([0, 1, 2]);
  });
});

describe('applyReorder (편집 모달 낙관 경로 — 코드만 재배열)', () => {
  it('코드가 차지하던 order 슬롯을 재사용해 메모를 제자리에 남긴다', async () => {
    // 서버 reorder_entries 와 같은 시맨틱: 코드 슬롯에만 새 순서를 채우고 메모는
    // items 인덱스에 고정. 낙관값이 rank(0,1,…)를 쓰면 **메모와 충돌**한다 —
    // items [005930(0), memo(1), 000660(2)] 에서 rank 는 000660→0, 005930→1 이 되어
    // 005930 이 메모와 같은 order 를 갖는다.
    vi.spyOn(api, 'reorderEntries').mockImplementation(() => new Promise(() => {}));
    const qc = seededClient();
    const { result } = renderHook(() => useReorderEntries(), { wrapper: wrap(qc) });

    act(() => {
      result.current.mutate({ folderId: 'f_a', orderedCodes: ['000660', '005930'] });
    });

    await waitFor(() => {
      const d = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY)!;
      expect(d.entries.find((e) => e.code === '000660')!.order).toBe(0);
    });
    const d = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY)!;
    // 코드는 0 과 2 를 교환하고, 메모는 1 에 그대로 있어야 한다.
    expect(d.entries.find((e) => e.code === '000660')!.order).toBe(0);
    expect(d.entries.find((e) => e.code === '005930')!.order).toBe(2);
    expect(d.memos[0].order).toBe(1);
    // 축이 겹치지 않는다 — 겹치면 병합 정렬에서 행이 서로를 덮는다
    const all = [...d.entries.map((e) => e.order), ...d.memos.map((m) => m.order)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('applyAddMember (종목 추가 낙관 경로)', () => {
  it('폴더 끝이 메모여도 새 종목이 그 뒤에 온다', async () => {
    // items: [005930(0), 000660(2)] + memo(1) → 다음 슬롯은 3이다.
    // entries 만으로 max 를 구하면 2+1=3 이 맞지만, 메모가 **끝**에 있는 배치에서
    // 어긋나므로 그 배치로 다시 잰다.
    const tailMemo: WatchlistResponse = {
      ...seeded,
      entries: [seeded.entries[0]],                                   // 005930(0)
      memos: [{ id: 'm_00000001', folder_id: 'f_a', order: 1, text: '끝 메모' }],
    };
    vi.spyOn(api, 'addMember').mockImplementation(() => new Promise(() => {}));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(WATCHLIST_KEY, tailMemo);
    const { result } = renderHook(() => useAddMember(), { wrapper: wrap(qc) });

    act(() => {
      result.current.mutate({ folderId: 'f_a', code: '035720', name: '카카오' });
    });

    await waitFor(() => {
      const d = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY)!;
      expect(d.entries).toHaveLength(2);
    });
    const d = qc.getQueryData<WatchlistResponse>(WATCHLIST_KEY)!;
    const added = d.entries.find((e) => e.code === '035720')!;
    // 메모(1) 뒤여야 한다. entries-only max 였다면 0+1=1 로 **메모와 충돌**한다.
    expect(added.order).toBe(2);
    expect(added.order).not.toBe(d.memos[0].order);
  });
});
