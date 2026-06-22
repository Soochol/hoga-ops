import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  addToHeatmapFolder: vi.fn(() => Promise.resolve({
    code: '005930', name: '삼성전자', folder_id: null, order: 0 })),
}));

import { useAddToFolder } from './useAddToFolder';
import { addToHeatmapFolder } from '../api/heatmap';
import { INDEX_SECTOR_RANKINGS_KEY } from '../api/indexSectorRankings';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { vi.clearAllMocks(); });

it('추가 후 해당 폴더로 이동', async () => {
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(addToHeatmapFolder).toHaveBeenCalledWith('005930', 'f1');
});

it('이미 히트맵에 있으면 단일 command가 서버에서 이동까지 처리한다', async () => {
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await act(async () => { await result.current.addToFolder('005930', 'f1'); });
  expect(addToHeatmapFolder).toHaveBeenCalledWith('005930', 'f1');
});

it('단일 command가 실패하면 에러를 전파한다', async () => {
  vi.mocked(addToHeatmapFolder).mockRejectedValueOnce(new Error('boom'));
  const { result } = renderHook(() => useAddToFolder(), { wrapper });
  await expect(
    act(async () => { await result.current.addToFolder('005930', 'f1'); }),
  ).rejects.toThrow('boom');
});

it('히트맵 멤버십 변경 후 index sector ranking cache도 무효화한다', async () => {
  const qc = new QueryClient();
  const rankingKey = [...INDEX_SECTOR_RANKINGS_KEY, '20260619'] as const;
  qc.setQueryData(rankingKey, {
    date: '20260619',
    source: 'daily_adjusted',
    unavailable_reason: null,
    sectors: [],
  });
  const customWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useAddToFolder(), { wrapper: customWrapper });

  await act(async () => { await result.current.addToFolder('005930', 'f1'); });

  expect(qc.getQueryState(rankingKey)?.isInvalidated).toBe(true);
});
