import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  addToHeatmap: vi.fn(() => Promise.resolve({
    code: '005930', name: '삼성전자', folder_id: null, order: 0 })),
  moveHeatmapEntries: vi.fn(() => Promise.resolve()),
}));

import { useAddToFolder } from './useAddToFolder';
import { addToHeatmap, moveHeatmapEntries } from '../api/heatmap';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { vi.clearAllMocks(); });

it('추가 후 해당 폴더로 이동', async () => {
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(addToHeatmap).toHaveBeenCalledWith('005930');
  expect(moveHeatmapEntries).toHaveBeenCalledWith(['005930'], 'f1');
});

it('이미 히트맵에 있으면(409) add 건너뛰고 move만', async () => {
  // 실제 ApiError 형태로 모킹 — .code 가 핵심(message 가 아님).
  vi.mocked(addToHeatmap).mockRejectedValueOnce(
    Object.assign(new Error('Code 005930 is already in the Heatmap.'), {
      code: 'already_in_heatmap', status: 409,
    }),
  );
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(moveHeatmapEntries).toHaveBeenCalledWith(['005930'], 'f1');
});

it('add가 다른 에러면 전파(move 안 함)', async () => {
  vi.mocked(addToHeatmap).mockRejectedValueOnce(new Error('boom'));
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await expect(
    act(async () => { await result.current.addToFolder('005930', 'f1'); }),
  ).rejects.toThrow('boom');
  expect(moveHeatmapEntries).not.toHaveBeenCalled();
});
