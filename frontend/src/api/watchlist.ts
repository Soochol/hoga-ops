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
                                   // null은 heatmap(v2, 공유 타입)의 미분류용으로만 존재
  order: number;                   // 0-based, 폴더 내 인덱스
  capture_candidate?: boolean;     // code-level: any capture-enabled watchlist membership
}

export interface WatchlistResponse {
  folders: WatchlistFolder[];
  entries: WatchlistEntry[];
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
 *  `code` is stable (e.g. `kis_holiday_fetch_failed`, `catchup_failed`); the
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
