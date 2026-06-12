import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useWatchlistMembership } from './useWatchlistMembership';

function wrapper(rows: { code: string; folder_id: string }[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    folders: [], next_run_at_ms: 0,
    entries: rows.map((r, i) => ({
      code: r.code, name: r.code, registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: r.folder_id, order: i,
    })),
  });
  return ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useWatchlistMembership (v3, ADR-0070)', () => {
  it('isMember reflects whether the code is in ≥1 folder', () => {
    const { result } = renderHook(() => useWatchlistMembership(),
      { wrapper: wrapper([{ code: '005930', folder_id: 'f_a' }]) });
    expect(result.current.isMember('005930')).toBe(true);
    expect(result.current.isMember('000660')).toBe(false);
  });

  it('folderIdsOf returns the set of folders a code belongs to (multi-membership)', () => {
    const { result } = renderHook(() => useWatchlistMembership(), {
      wrapper: wrapper([
        { code: '005930', folder_id: 'f_a' },
        { code: '005930', folder_id: 'f_b' },  // 다중 소속: 같은 코드 두 폴더
      ]),
    });
    expect([...result.current.folderIdsOf('005930')].sort()).toEqual(['f_a', 'f_b']);
    expect(result.current.folderIdsOf('000660').size).toBe(0);
  });
});
