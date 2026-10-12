import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/watchlist';
import type { WatchlistEntry, WatchlistResponse } from '../api/watchlist';
import { WatchlistGroupPicker } from './WatchlistGroupPicker';

function setup(initialEntries: WatchlistEntry[] = []) {
  let data: WatchlistResponse = {
    folders: [{ id: 'f_a', name: '관찰', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
    entries: initialEntries, memos: [], next_run_at_ms: 0,
  };
  vi.spyOn(api, 'getWatchlist').mockImplementation(async () => data);
  const add = vi.spyOn(api, 'addMember').mockImplementation(async (folderId, code, at) => {
    const entry = { code, name: '삼성전자', folder_id: folderId, order: at ?? 0,
      registered_at_kst_date: '20260101', last_success_date: null };
    data = { ...data, entries: [...data.entries, entry] };
    return entry;
  });
  const remove = vi.spyOn(api, 'removeMember').mockImplementation(async (folderId, code) => {
    data = { ...data, entries: data.entries.filter(e => e.code !== code || e.folder_id !== folderId) };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['watchlist'], data);
  const drag = vi.fn();
  render(<QueryClientProvider client={qc}>
    <div onPointerDown={drag}>
      <WatchlistGroupPicker code="005930" name="삼성전자" x={0} y={0} onClose={vi.fn()} />
    </div>
  </QueryClientProvider>);
  return { add, remove, drag };
}

beforeEach(() => vi.restoreAllMocks());

describe('watchlist group changes', () => {
  it('adds the current stock and undoes only the last group without dragging the window', async () => {
    const { add, remove, drag } = setup();
    const first = screen.getByRole('checkbox', { name: '관찰' });
    fireEvent.pointerDown(first);
    fireEvent.click(first);
    expect(drag).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 취소' })).toBeEnabled());
    expect(add).toHaveBeenCalledWith('f_a', '005930', undefined);
    fireEvent.click(screen.getByRole('checkbox', { name: '장기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 취소' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '실행 취소' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '실행 취소' })).toBeNull());
    expect(remove).toHaveBeenCalledWith('f_b', '005930');
    expect(screen.getByRole('checkbox', { name: '관찰' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '장기' })).not.toBeChecked();
  });

  it('restores a removed member at its original position', async () => {
    const { add } = setup([{ code: '005930', name: '삼성전자', folder_id: 'f_a', order: 3,
      registered_at_kst_date: '20260101', last_success_date: null }]);
    fireEvent.click(screen.getByRole('checkbox', { name: '관찰' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '실행 취소' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '실행 취소' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_a', '005930', 3));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '관찰' })).toBeChecked());
  });

  it('rolls back failed registration and exposes a retryable error', async () => {
    const { add } = setup();
    add.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('checkbox', { name: '관찰' }));
    await screen.findByText('저장하지 못했습니다. 다시 시도해 주세요.');
    expect(screen.getByRole('checkbox', { name: '관찰' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: '실행 취소' })).toBeNull();
  });
});
