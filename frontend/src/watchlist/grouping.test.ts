import { describe, it, expect } from 'vitest';
import { groupByFolder, selectVisibleEntries, swapFolderOrder } from './grouping';
import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';

const folders: WatchlistFolder[] = [
  { id: 'f_b', name: '스윙', order: 1 },
  { id: 'f_a', name: '장기', order: 0 },
];
const entries: WatchlistEntry[] = [
  { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 1 },
  { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 0 },
  { code: '035720', name: '카카오', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
];

describe('groupByFolder', () => {
  it('orders folders by .order and 미분류 last; sorts entries by .order; 미분류 is a render group, not a synthetic folder', () => {
    const groups = groupByFolder(folders, entries);
    expect(groups.map((g) => g.folder?.name ?? '미분류')).toEqual(['장기', '스윙', '미분류']);
    const swing = groups.find((g) => g.folder?.id === 'f_b')!;
    expect(swing.entries.map((e) => e.code)).toEqual(['000660', '005930']);  // by order
    const uncat = groups.find((g) => g.folder === null)!;
    expect(uncat.folder).toBeNull();           // null, NOT a {id:'uncategorized'} object
    expect(uncat.entries.map((e) => e.code)).toEqual(['035720']);
  });
  it('includes empty folders', () => {
    const groups = groupByFolder([{ id: 'f_x', name: '빈', order: 0 }], []);
    expect(groups.map((g) => g.folder?.name ?? '미분류')).toEqual(['빈', '미분류']);
    expect(groups[0].entries).toEqual([]);
  });
});

describe('selectVisibleEntries (drag-index contract shared by pane + modal)', () => {
  it('a folder id returns only that folder, by .order', () => {
    expect(selectVisibleEntries(entries, 'f_b').map((e) => e.code)).toEqual(['000660', '005930']);
  });
  it('null returns the 미분류 entries', () => {
    expect(selectVisibleEntries(entries, null).map((e) => e.code)).toEqual(['035720']);
  });
  it('does not mutate the input array', () => {
    const before = entries.map((e) => e.code);
    selectVisibleEntries(entries, 'f_b');
    expect(entries.map((e) => e.code)).toEqual(before);
  });
});

describe('swapFolderOrder (패널 ⋯ 메뉴 + 편집 모달 ▲▼ 공유 계약)', () => {
  // folders는 order 역순 선언(f_b=1, f_a=0) — 정렬 후 [f_a, f_b].
  it('moves a folder down: full ordered_ids with the pair swapped', () => {
    expect(swapFolderOrder(folders, 'f_a', +1)).toEqual(['f_b', 'f_a']);
  });
  it('moves a folder up', () => {
    expect(swapFolderOrder(folders, 'f_b', -1)).toEqual(['f_b', 'f_a']);
  });
  it('returns null at the boundary (first up / last down)', () => {
    expect(swapFolderOrder(folders, 'f_a', -1)).toBeNull();
    expect(swapFolderOrder(folders, 'f_b', +1)).toBeNull();
  });
  it('returns null for an unknown id', () => {
    expect(swapFolderOrder(folders, 'f_zzz', +1)).toBeNull();
  });
  it('does not mutate the input array', () => {
    const before = folders.map((f) => f.id);
    swapFolderOrder(folders, 'f_a', +1);
    expect(folders.map((f) => f.id)).toEqual(before);
  });
});
