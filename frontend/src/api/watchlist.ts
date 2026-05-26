import { apiCall, apiAction } from './client';

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

// --- Manual catch-up (spec 2026-05-27) ------------------------------------

/** Minimal QueueItem shape — only the fields the frontend currently reads
 * from EnqueueResponse.enqueued. Mirrors backend hoga/api/models.py:QueueItem.
 * The frontend just counts items for the banner, so a thin shape is fine. */
export interface EnqueueQueueItem {
  item_id: string;
  code: string;
  date: string;
  phase: string;
}

export interface EnqueueDedupedRow {
  code: string;
  date: string;
  reason: string;
}

export interface EnqueueResponse {
  enqueued: EnqueueQueueItem[];
  deduped: EnqueueDedupedRow[];
}

export interface ManualCatchupAllEntryResult {
  code: string;
  name: string;
  enqueued_count: number;
  deduped_count: number;
  error: string | null;
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
