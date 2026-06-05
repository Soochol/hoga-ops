import { apiCall, apiAction } from './client';
import type { EnqueueResponse } from './types';

export type { EnqueueResponse } from './types';

export interface WatchlistEntry {
  code: string;
  name: string;
  registered_at_kst_date: string;  // YYYYMMDD
  last_success_date: string | null;
}

export interface WatchlistResponse {
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

export function reorderWatchlist(codes: string[]): Promise<WatchlistResponse> {
  return apiCall<WatchlistResponse>('/api/watchlist/order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
