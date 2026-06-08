import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';
import { useLivePageStore } from '../state/livePage';

// ADR-0057: 패널 드래그의 wiring contract만 검증 — 실제 dnd-kit 포인터/충돌은 e2e가 담당.
// DndContext를 passthrough로 모킹해 주입된 onDragEnd를 캡처하고, useSortable은 no-op으로 둔다.
const h = vi.hoisted(() => ({ onDragEnd: null as null | ((e: unknown) => void) }));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (e: unknown) => void }) => {
      h.onDragEnd = onDragEnd;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      setNodeRef: () => {}, listeners: {}, attributes: {},
      transform: null, transition: undefined, isDragging: false,
    }),
  };
});

import { WatchlistDrawer } from './WatchlistDrawer';

const FOLDERS = [
  { id: 'f_0000000a', name: '스윙', order: 0 },
  { id: 'f_0000000b', name: '장기', order: 1 },
];
const ENTRIES = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
];
const DATA = { folders: FOLDERS, entries: ENTRIES, next_run_at_ms: 0 };

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('WatchlistDrawer drag wiring', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    h.onDragEnd = null;
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
  });

  it('entry-drag onDragEnd → reorderEntries(folderId, orderedCodes)', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    h.onDragEnd!({
      active: { id: '005930', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
      over: { id: '000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('f_0000000a', ['000660', '005930']));
  });
});
