import { describe, it, expect } from 'vitest';
import { resolveDrag } from './dragHandlers';
import type { WatchlistEntry } from '../api/watchlist';
const mk = (code: string, order: number, folder_id: string | null = null): WatchlistEntry =>
  ({ code, name: code, registered_at_kst_date: '20260101', last_success_date: null, folder_id, order });

describe('resolveDrag', () => {
  const list = [mk('005930', 0), mk('000660', 1), mk('035720', 2)];
  it('reorders within the folder when dropped on a row', () => {
    expect(resolveDrag(list, null, '035720', '005930'))
      .toEqual({ kind: 'reorder', folderId: null, orderedCodes: ['035720', '005930', '000660'] });
  });
  it('moves to a folder when dropped on a folder droppable', () => {
    expect(resolveDrag(list, null, '005930', 'folder:f_a'))
      .toEqual({ kind: 'move', codes: ['005930'], folderId: 'f_a' });
  });
  it('move onto 미분류 droppable yields folderId null', () => {
    expect(resolveDrag(list, 'f_a', '005930', 'folder:__uncat__'))
      .toEqual({ kind: 'move', codes: ['005930'], folderId: null });
  });
  it('no-op when dropped on its own folder or itself', () => {
    expect(resolveDrag(list, null, '005930', 'folder:__uncat__')).toEqual({ kind: 'none' });
    expect(resolveDrag(list, null, '005930', '005930')).toEqual({ kind: 'none' });
  });
});
