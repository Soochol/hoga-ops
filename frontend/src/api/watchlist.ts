import { apiCall, apiAction } from './client';
import type { EnqueueResponse } from './types';

export type { EnqueueResponse } from './types';

export interface WatchlistFolder {
  id: string;
  name: string;
  order: number;
  capture_enabled?: boolean;
}

export interface WatchlistEntry {
  code: string;
  name: string;
  registered_at_kst_date: string;  // YYYYMMDD
  last_success_date: string | null;
  folder_id: string | null;        // watchlist v3 와이어는 항상 실폴더(null 없음, ADR-0070);
                                   // heatmap 도 v3 부터 자체 HeatmapEntry(비-null)를 쓴다(ADR-0112)
                                   // — null 은 grouping.ts 제네릭 하위호환으로만 남아 있다
  order: number;                   // 폴더 items 인덱스(v4) — 메모 행이 차지한 자리를
                                   // 건너뛰므로 이 배열만 보면 띄엄띄엄하다. WatchlistMemo
                                   // 와 합치면 0..N-1 로 조밀하다. **정렬 키로만 쓸 것**
  capture_candidate?: boolean;     // code-level: any capture-enabled watchlist membership
}

/** 리스트에 끼워 넣는 "빈칸" 행(v4). 종목명 자리에 `text` 가 보이고, `text: ''` 는
 *  빈 줄이라는 정상 상태다(폴더 이름과 정반대 — blank 를 거절하지 않는다).
 *
 *  `order` 는 WatchlistEntry.order 와 **같은 축**(폴더 items 인덱스)이다. 두 배열을
 *  각각 보면 값이 띄엄띄엄하지만, entries∪memos 는 폴더당 0..N-1 로 조밀하다 —
 *  order 로 정렬해 병합하면 원래 표시 순서가 그대로 복원된다. */
export interface WatchlistMemo {
  id: string;                      // m_ + 8 hex
  folder_id: string;
  order: number;
  text: string;
}

export interface WatchlistResponse {
  folders: WatchlistFolder[];
  entries: WatchlistEntry[];
  memos: WatchlistMemo[];
  next_run_at_ms: number;
}

export function getWatchlist(): Promise<WatchlistResponse> {
  return apiCall<WatchlistResponse>('/api/watchlist');
}

/** v3 멤버십(ADR-0070): code를 folderId의 멤버로 추가. entry 없으면 백엔드가 생성. */
export function addMember(folderId: string, code: string): Promise<WatchlistEntry> {
  return apiCall<WatchlistEntry>(`/api/watchlist/folders/${folderId}/members`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

/** v3 멤버십: code를 folderId에서 제거. 어느 폴더에도 없으면 백엔드가 entry 삭제. */
export function removeMember(folderId: string, code: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}/members/${code}`, { method: 'DELETE' });
}

/** 관심종목에서 코드 전체 제거(모든 폴더에서 빼고 entry 삭제). 드로어 quick-remove. */
export function removeFromWatchlist(code: string): Promise<void> {
  return apiAction(`/api/watchlist/${code}`, { method: 'DELETE' });
}

// --- Folders + bulk move/reorder/remove (spec 2026-05-31) -----------------

export function createFolder(name: string): Promise<WatchlistFolder> {
  return apiCall<WatchlistFolder>('/api/watchlist/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function renameFolder(folderId: string, name: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
export function setFolderCaptureEnabled(
  folderId: string,
  capture_enabled: boolean,
): Promise<WatchlistFolder> {
  return apiCall<WatchlistFolder>(`/api/watchlist/folders/${folderId}/capture`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture_enabled }),
  });
}
export function deleteFolder(folderId: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}`, { method: 'DELETE' });
}
export function reorderFolders(orderedIds: string[]): Promise<void> {
  return apiAction('/api/watchlist/folders/order', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_ids: orderedIds }),
  });
}
export function reorderEntries(folderId: string, orderedCodes: string[]): Promise<void> {
  return apiAction('/api/watchlist/reorder', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId, ordered_codes: orderedCodes }),
  });
}
// --- 메모("빈칸") 아이템 (v4) ---------------------------------------------
// 셋 다 Live Set 에 영향이 없다(메모는 Code 가 아니다) — 백엔드도 이 라우트들에선
// refresh_live_stream 을 부르지 않는다.

/** 폴더에 빈칸을 삽입. `at` = items 인덱스, 생략하면 맨 아래. 범위를 넘으면 끝으로
 *  클램프된다(422 아님 — 동시 편집으로 길이가 줄었을 뿐인 흔한 경우). */
export function addMemo(folderId: string, text = '', at?: number): Promise<WatchlistMemo> {
  return apiCall<WatchlistMemo>(`/api/watchlist/folders/${folderId}/memos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, at: at ?? null }),
  });
}

/** 메모 텍스트 교체. `''` 는 빈 줄로 정상 저장된다. */
export function updateMemo(memoId: string, text: string): Promise<WatchlistMemo> {
  return apiCall<WatchlistMemo>(`/api/watchlist/memos/${memoId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

export function removeMemo(memoId: string): Promise<void> {
  return apiAction(`/api/watchlist/memos/${memoId}`, { method: 'DELETE' });
}

export function removeEntries(codes: string[]): Promise<void> {
  return apiAction('/api/watchlist/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
}

// --- Manual catch-up (spec 2026-05-27) ------------------------------------
// EnqueueResponse / EnqueueDedupedRow / QueueItem live in ./types so the
// wire shape stays single-source-of-truth for both /api/captures/items and
// /api/watchlist/{code}/catchup. Re-exported above for ergonomic imports
// from this module.

/** Structured error envelope — mirrors hoga/api/models.py::ManualCatchupError.
 *  `code` is stable (e.g. `trading_days_unavailable`, `catchup_failed`); the
 *  panel can branch on it instead of regex-matching exception strings. */
export interface ManualCatchupError {
  code: string;
  message: string;
}

export interface ManualCatchupAllEntryResult {
  code: string;
  name: string;
  enqueued_count: number;
  deduped_count: number;
  error: ManualCatchupError | null;
}

export interface ManualCatchupAllResponse {
  results: ManualCatchupAllEntryResult[];
}

export function catchupNow(code: string): Promise<EnqueueResponse> {
  return apiCall<EnqueueResponse>(`/api/watchlist/${code}/catchup`, {
    method: 'POST',
  });
}

export function catchupAll(): Promise<ManualCatchupAllResponse> {
  return apiCall<ManualCatchupAllResponse>('/api/watchlist/catchup', {
    method: 'POST',
  });
}
