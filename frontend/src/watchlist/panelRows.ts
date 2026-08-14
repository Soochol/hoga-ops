import type { WatchlistEntry, WatchlistMemo, WatchlistItemRef } from '../api/watchlist';

/** 패널이 그리는 한 행 — 종목이거나 메모("빈칸")다(v4). */
export type PanelRow =
  | { kind: 'entry'; entry: WatchlistEntry }
  | { kind: 'memo'; memo: WatchlistMemo };

/**
 * 한 폴더의 entries + memos 를 **표시 순서**로 병합한다.
 *
 * 두 배열의 `order` 는 같은 축(폴더 items 인덱스)이다. 각각만 보면 값이 띄엄띄엄하지만
 * 합치면 폴더당 0..N-1 로 조밀하다 — 백엔드 project_entry_views / project_memo_views 가
 * 같은 enumerate 에서 만들기 때문이다. 그래서 여기서는 **order 로 정렬만** 하면 원래
 * 순서가 복원된다.
 *
 * ⚠ order 를 배열 인덱스로 쓰지 말 것. 정렬 키로만 쓴다 — 서버가 조밀성을 보장하지만
 * 낙관적 업데이트 도중에는 잠시 어긋날 수 있다.
 */
export function mergePanelRows(entries: WatchlistEntry[], memos: WatchlistMemo[]): PanelRow[] {
  const rows: { order: number; row: PanelRow }[] = [
    ...entries.map((entry) => ({ order: entry.order, row: { kind: 'entry' as const, entry } })),
    ...memos.map((memo) => ({ order: memo.order, row: { kind: 'memo' as const, memo } })),
  ];
  rows.sort((a, b) => a.order - b.order);
  return rows.map((r) => r.row);
}

/** 폴더의 memos 만 골라 order 순으로. */
export function memosOfFolder(memos: WatchlistMemo[], folderId: string): WatchlistMemo[] {
  return memos.filter((m) => m.folder_id === folderId).sort((a, b) => a.order - b.order);
}

/** PanelRow 배열 → 서버 재배열 계약(ordered_items). 화면에 보이는 순서 그대로 보낸다. */
export function toItemRefs(rows: PanelRow[]): WatchlistItemRef[] {
  return rows.map((r) =>
    r.kind === 'entry'
      ? { kind: 'code' as const, code: r.entry.code }
      : { kind: 'memo' as const, id: r.memo.id },
  );
}

/** PanelRow 의 dnd sortable 키(폴더 스코프 앞부분은 호출부가 붙인다). */
export function panelRowKey(row: PanelRow): string {
  return row.kind === 'entry' ? row.entry.code : row.memo.id;
}
