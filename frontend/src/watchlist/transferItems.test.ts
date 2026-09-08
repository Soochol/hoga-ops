import { describe, expect, it } from 'vitest';
import type { WatchlistResponse, WatchlistItemRef } from '../api/watchlist';
import { applyTransfer, folderItems, inverseTransfer, planTransfer } from './transferItems';
const A = 'f_0000000a', B = 'f_0000000b', C = 'f_0000000c';
const code = (code: string): WatchlistItemRef => ({ kind: 'code', code });
const data: WatchlistResponse = {
  folders: [A, B, C].map((id, order) => ({ id, name: id, order })),
  entries: [[A, '005930', 0], [A, '000660', 2], [B, '035420', 0], [B, '005930', 1], [C, '005930', 0]].map(([folder_id, code, order]) => ({
    folder_id: String(folder_id), code: String(code), name: String(code), order: Number(order),
    registered_at_kst_date: '20260908', last_success_date: null,
  })),
  memos: [{ folder_id: A, id: 'm_00000001', order: 1, text: '메모 내용' }], next_run_at_ms: 0,
};
describe('watchlist transfer plan', () => {
  it('inserts at a target gap, merges duplicates and keeps unselected memberships', () => {
    const changes = planTransfer(data, [{ folderId: A, code: '005930' }, { folderId: A, code: '000660' }], B, 0);
    const moved = applyTransfer(data, changes);
    expect(folderItems(moved, B)).toEqual([code('005930'), code('000660'), code('035420')]);
    expect(folderItems(moved, A)).toEqual([{ kind: 'memo', id: 'm_00000001' }]);
    expect(folderItems(moved, C)).toEqual([code('005930')]);
    expect(moved.memos[0].text).toBe('메모 내용');
    const restored = applyTransfer(moved, inverseTransfer(changes));
    for (const id of [A, B, C]) expect(folderItems(restored, id)).toEqual(folderItems(data, id));
  });
  it('includes an unchanged duplicate destination so atomic validation and undo preserve the code', () => {
    const changes = planTransfer(data, [{ folderId: C, code: '005930' }], B, 2);
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.folder_id === B)).toEqual({ folder_id: B, before: folderItems(data, B), after: folderItems(data, B) });
    expect(folderItems(applyTransfer(data, changes), C)).toEqual([]);
  });
  it('handles a same-folder downward gap with memo rows without off-by-one', () => {
    const changes = planTransfer(data, [{ folderId: A, code: '005930' }], A, 2);
    expect(folderItems(applyTransfer(data, changes), A)).toEqual([{ kind: 'memo', id: 'm_00000001' }, code('005930'), code('000660')]);
    expect(planTransfer(data, [{ folderId: A, code: '005930' }], A, 1)).toEqual([]);
  });
  it('moves selections from multiple folders as one stable block', () => {
    const changes = planTransfer(data, [{ folderId: A, code: '000660' }, { folderId: B, code: '035420' }], C, 1);
    expect(folderItems(applyTransfer(data, changes), C)).toEqual([code('005930'), code('000660'), code('035420')]);
    expect(changes).toHaveLength(3);
  });
  it('sorted destinations preserve existing manual order and append only new codes', () => {
    const changes = planTransfer(data, [{ folderId: A, code: '005930' }, { folderId: A, code: '000660' }], B, 0, true);
    expect(folderItems(applyTransfer(data, changes), B)).toEqual([code('035420'), code('005930'), code('000660')]);
  });
  it('ignores stale selections and nonexistent targets', () => {
    expect(planTransfer(data, [{ folderId: A, code: '999999' }], B, 0)).toEqual([]);
    expect(planTransfer(data, [{ folderId: A, code: '005930' }], 'missing', 0)).toEqual([]);
  });
});
