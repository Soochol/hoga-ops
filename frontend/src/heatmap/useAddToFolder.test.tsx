import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  addToWatchlist: vi.fn(() => Promise.resolve({
    code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
    last_success_date: null, folder_id: null, order: 0 })),
  moveEntries: vi.fn(() => Promise.resolve()),
}));

import { useAddToFolder } from './useAddToFolder';
import { addToWatchlist, moveEntries } from '../api/watchlist';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { vi.clearAllMocks(); });

it('추가 후 해당 폴더로 이동', async () => {
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(addToWatchlist).toHaveBeenCalledWith('005930');
  expect(moveEntries).toHaveBeenCalledWith(['005930'], 'f1');
});

it('이미 관심종목(409)이면 add 건너뛰고 move만', async () => {
  // 실제 ApiError 형태로 모킹 — .code 가 핵심(message 가 아님).
  vi.mocked(addToWatchlist).mockRejectedValueOnce(
    Object.assign(new Error('Code 005930 is already in the Watchlist.'), {
      code: 'already_in_watchlist', status: 409,
    }),
  );
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(moveEntries).toHaveBeenCalledWith(['005930'], 'f1');
});

it('add가 다른 에러면 전파(move 안 함)', async () => {
  vi.mocked(addToWatchlist).mockRejectedValueOnce(new Error('boom'));
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await expect(
    act(async () => { await result.current.addToFolder('005930', 'f1'); }),
  ).rejects.toThrow('boom');
  expect(moveEntries).not.toHaveBeenCalled();
});
