import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { useReorderHeatmapFolders } from './useHeatmap';
import { HEATMAP_KEY } from './heatmapKeys';
import type { HeatmapResponse } from '../api/heatmap';
import { reorderHeatmapFolders } from '../api/heatmap';

vi.mock('../api/heatmap', async original => ({
  ...await original<typeof import('../api/heatmap')>(), reorderHeatmapFolders: vi.fn(),
}));

it('failed folder order rolls back only order, preserving latest groups, names and memberships', async () => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const initial: HeatmapResponse = {
    folders: ['a', 'b', 'c'].map((id, order) => ({ id, name: id, order })),
    entries: [{ code: '005930', name: '삼성전자', folder_id: 'a', order: 0 }],
    capture_markers: {},
    next_run_at_ms: 0,
  };
  qc.setQueryData(HEATMAP_KEY, initial);
  let fail!: (error: Error) => void;
  vi.mocked(reorderHeatmapFolders).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const { result } = renderHook(useReorderHeatmapFolders, {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  act(() => result.current.mutate(['c', 'b', 'a']));
  await waitFor(() => expect(reorderHeatmapFolders).toHaveBeenCalledWith(['c', 'b', 'a']));
  const optimistic = qc.getQueryData<HeatmapResponse>(HEATMAP_KEY)!;
  expect(optimistic.folders.find(folder => folder.id === 'c')?.order).toBe(0);
  const latest: HeatmapResponse = {
    ...optimistic,
    folders: [...optimistic.folders.filter(folder => folder.id !== 'b')
      .map(folder => ({ ...folder, name: `${folder.id} renamed` })), { id: 'd', name: 'new', order: 3 }],
    entries: [{ code: '000660', name: 'SK하이닉스', folder_id: 'd', order: 0 }],
    capture_markers: { '000660': '20261104' },
  };
  qc.setQueryData(HEATMAP_KEY, latest);
  await act(async () => fail(new Error('409 folder set changed')));
  await waitFor(() => expect(result.current.isError).toBe(true));
  const restored = qc.getQueryData<HeatmapResponse>(HEATMAP_KEY)!;
  expect(restored.entries).toEqual(latest.entries);
  expect(restored.capture_markers).toEqual(latest.capture_markers);
  expect(restored.folders.slice().sort((a, b) => a.order - b.order)).toEqual([
    { id: 'a', name: 'a renamed', order: 0 },
    { id: 'c', name: 'c renamed', order: 1 },
    { id: 'd', name: 'new', order: 2 },
  ]);
  qc.clear();
});
