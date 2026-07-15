import { apiAction, apiCall, type ApiError } from './client';
import type {
  BulkEnqueueResponse,
  CaptureErrorCode,
  CoveragePreviewResponse,
  EnqueueRequest,
  EnqueueResponse,
  MissingStockDate,
  QueueSnapshot,
  RetryRequest,
  RetryResponse,
} from './types';

/** 여러 종목의 지난 N일 hogaplay 커버리지 미리보기. lookback_days 또는 start/end. */
export function coveragePreview(
  body: { codes: string[]; lookback_days?: number; start_date?: string; end_date?: string },
): Promise<CoveragePreviewResponse> {
  return apiCall<CoveragePreviewResponse>('/api/captures/coverage-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** coverage-preview.missing 를 (code→dates) 로 묶어 일괄 적재. */
export function bulkItems(missing: MissingStockDate[]): Promise<BulkEnqueueResponse> {
  const byCode = new Map<string, string[]>();
  for (const m of missing) {
    const cur = byCode.get(m.code);
    if (cur) cur.push(m.date);
    else byCode.set(m.code, [m.date]);
  }
  const items = [...byCode.entries()].map(([code, dates]) => ({ code, dates }));
  return apiCall<BulkEnqueueResponse>('/api/captures/bulk-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
}

/** Narrowed ApiError for captures-router calls — `code` is a member of
 *  CaptureErrorCode (mirrors hoga/api/error_codes.py). Consumers wanting
 *  typed dispatch on the code can `err as CaptureRestError`. */
export interface CaptureRestError extends ApiError {
  code?: CaptureErrorCode;
}

export function addItems(req: EnqueueRequest): Promise<EnqueueResponse> {
  return apiCall<EnqueueResponse>('/api/captures/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

export function getQueue(): Promise<QueueSnapshot> {
  return apiCall<QueueSnapshot>('/api/captures/queue');
}

export async function cancelItem(itemId: string): Promise<void> {
  // 409 = item already terminal. Semantically a success for "cancel" intent —
  // the item is no longer running. Swallow it; other statuses propagate.
  try {
    await apiAction(`/api/captures/items/${encodeURIComponent(itemId)}/cancel`, { method: 'POST' });
  } catch (err) {
    if ((err as ApiError).status !== 409) throw err;
  }
}

export function cancelAll(): Promise<void> {
  return apiAction('/api/captures/cancel-all', { method: 'POST' });
}

export function resumeQueue(): Promise<void> {
  return apiAction('/api/captures/queue/resume', { method: 'POST' });
}

export function dismissDone(): Promise<void> {
  return apiAction('/api/captures/done', { method: 'DELETE' });
}

export function retryItems(req: RetryRequest): Promise<RetryResponse> {
  return apiCall<RetryResponse>('/api/captures/items/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}
