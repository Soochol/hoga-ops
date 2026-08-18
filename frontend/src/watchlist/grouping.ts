import type { WatchlistFolder, WatchlistEntry } from '../api/watchlist';

export interface EntryWithFolderOrder {
  folder_id: string | null;
  order: number;
}

export interface FolderGroup<TEntry extends EntryWithFolderOrder = WatchlistEntry> {
  /** null = 미분류 (a render-only group; NOT a synthetic folder object — ADR-0004) */
  folder: WatchlistFolder | null;
  entries: TEntry[];
}

/** UI folder selection: null = 미분류, string = a folder id. */
export type Selected = null | string;

/** The selected folder's entries, sorted by `.order` (null = 미분류, string = folder id).
 *  Shared by the entry pane (what it renders) and the edit modal (the list it
 *  feeds resolveDrag for row indices) so the two stay in lockstep — the
 *  drag-reorder index contract lives in one function, not a comment two files
 *  apart. Pure — no fetch, no synthetic objects. */
export function selectVisibleEntries<TEntry extends EntryWithFolderOrder>(
  entries: TEntry[],
  selected: Selected,
): TEntry[] {
  const list = entries.filter((e) => e.folder_id === selected);
  return [...list].sort((a, b) => a.order - b.order);
}

/** Group entries by folder for display. Folders sorted by `.order`; 미분류
 *  (folder_id===null) always last. Entries within a group sorted by `.order`.
 *  Empty folders are included. Pure — no fetch, no synthetic objects. */
export function groupByFolder<TEntry extends EntryWithFolderOrder>(
  folders: WatchlistFolder[],
  entries: TEntry[],
): FolderGroup<TEntry>[] {
  const sortedFolders = [...folders].sort((a, b) => a.order - b.order);
  const byOrder = (a: TEntry, b: TEntry) => a.order - b.order;
  const groups: FolderGroup<TEntry>[] = sortedFolders.map((folder) => ({
    folder,
    entries: entries.filter((e) => e.folder_id === folder.id).sort(byOrder),
  }));
  groups.push({
    folder: null,
    entries: entries.filter((e) => e.folder_id === null).sort(byOrder),
  });
  return groups;
}

/** 폴더 하나를 한 칸 위/아래로 옮긴 전체 id 순서를 만든다 — 서버 reorder_folders가
 *  전체 id 목록을 요구하는 계약(authoritative ordered_ids)의 클라이언트 절반.
 *  경계 밖(맨 위에서 위로 등)이나 미존재 id면 null. 패널 ⋯ 메뉴와 편집 모달
 *  ▲▼이 공유한다. Pure. */
export function swapFolderOrder(
  folders: WatchlistFolder[],
  folderId: string,
  dir: -1 | 1,
): string[] | null {
  const ids = [...folders].sort((a, b) => a.order - b.order).map((f) => f.id);
  const idx = ids.indexOf(folderId);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= ids.length) return null;
  [ids[idx], ids[j]] = [ids[j], ids[idx]];
  return ids;
}

/** `codes` 를 `folderId` 에서 뺐을 때 **관심종목에서 완전히 빠지는** 코드 수(고아).
 *  다른 폴더에도 있는 코드는 entry 가 살아남으므로 세지 않는다 — 서버
 *  `remove_member` 의 "제거 후 어느 폴더에도 없으면 entry 삭제" 와 같은 판정
 *  (ADR-0070, 불변식 단일 소유).
 *
 *  **이 계산이 두 화면의 확인 문구를 결정한다.** 관심종목 v3 는 다중 소속이라
 *  "그룹에서 뺀다" 가 곧 "관심종목에서 뺀다" 는 아니다 — 그런데 마지막 소속에서
 *  빼면 결과적으로 관심종목을 떠난다. 그 경계를 사용자에게 말해 주는 숫자다.
 *
 *  얼림은 호출자 몫이다: 확인 모달이 떠 있는 동안 폴링이 `entries` 를 갱신하면
 *  다시 센 값이 사용자가 읽은 숫자와 어긋나므로, 소비처들은 **띄우는 시점의
 *  결과를 state 에 담는다**. Pure. */
export function countOrphansIfRemovedFrom<TEntry extends EntryWithFolderOrder & { code: string }>(
  entries: TEntry[],
  folderId: string,
  codes: string[],
): number {
  const target = new Set(codes);
  const inOthers = new Set(entries.filter((e) => e.folder_id !== folderId).map((e) => e.code));
  const inThis = new Set(
    entries.filter((e) => e.folder_id === folderId && target.has(e.code)).map((e) => e.code));
  return [...inThis].filter((code) => !inOthers.has(code)).length;
}

/** 폴더를 통째로 지웠을 때의 고아 수 — 그 폴더의 **모든** 멤버를 빼는 것과 같다
 *  (서버 `delete_folder` 도 폴더만 지우고 orphan prune 은 같은 경로다).
 *
 *  패널(그룹 ⋯ 메뉴)과 편집 모달(휴지통)이 **같은 하나**를 쓴다. 파괴적 삭제의
 *  확인 문구에 들어가는 숫자라 두 화면이 다른 값을 말하면 안 된다 — 실제로
 *  편집 모달은 확인 자체가 없었다. Pure. */
export function countOrphansIfFolderDeleted<TEntry extends EntryWithFolderOrder & { code: string }>(
  entries: TEntry[],
  folderId: string,
): number {
  const all = entries.filter((e) => e.folder_id === folderId).map((e) => e.code);
  return countOrphansIfRemovedFrom(entries, folderId, all);
}
