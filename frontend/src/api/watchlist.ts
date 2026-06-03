import { apiCall, apiAction } from './client';
import type { EnqueueResponse } from './types';

export type { EnqueueResponse } from './types';

export interface WatchlistFolder {
  id: string;
  name: string;
  order: number;
}

export interface WatchlistEntry {
  code: string;
  name: string;
  registered_at_kst_date: string;  // YYYYMMDD
  last_success_date: string | null;
  folder_id: string | null;        // null = 미분류
  order: number;                   // 0-based, per-folder
}

export interface WatchlistResponse {
  folders: WatchlistFolder[];
  entries: WatchlistEntry[];
  next_run_at_ms: number;
}

export function getWatchlist(): Promise<WatchlistResponse> {
  return apiCall<WatchlistResponse>('/api/watchlist');
}

export function addToWatchlist(code: string): Promise<WatchlistEntry> {
  return apiCall<WatchlistEntry>('/api/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

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
export function deleteFolder(folderId: string): Promise<void> {
  return apiAction(`/api/watchlist/folders/${folderId}`, { method: 'DELETE' });
}
export function reorderFolders(orderedIds: string[]): Promise<void> {
  return apiAction('/api/watchlist/folders/order', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_ids: orderedIds }),
  });
}
export function moveEntries(codes: string[], folderId: string | null): Promise<void> {
  return apiAction('/api/watchlist/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes, folder_id: folderId }),
  });
}
export function reorderEntries(folderId: string | null, orderedCodes: string[]): Promise<void> {
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
 *  `code` is stable (e.g. `krx_credentials_missing`, `catchup_failed`); the
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
