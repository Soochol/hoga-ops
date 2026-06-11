import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

// 독립 스토어(ADR-0068): 페이지는 useHeatmap/useCreateHeatmapFolder → /api/heatmap 을 부른다.
vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }],
    entries: [{ code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 }],
  })),
  createHeatmapFolder: vi.fn(() => Promise.resolve({ id: 'f2', name: '방산', order: 1 })),
}));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useQuotes: vi.fn(() => ({ data: { phase: 'open', quotes: [] }, dataUpdatedAt: 0 })),
}));
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));

import { Heatmap } from './Heatmap';
import { createHeatmapFolder } from '../api/heatmap';

beforeEach(() => { vi.clearAllMocks(); });

it('＋새 그룹 → 이름 입력 → 만들기 시 createHeatmapFolder 호출', async () => {
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '＋ 새 그룹' }));
  fireEvent.change(screen.getByPlaceholderText('그룹 이름 입력'), { target: { value: '방산' } });
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(createHeatmapFolder).toHaveBeenCalledWith('방산'));
});
