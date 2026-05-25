import { apiAction, apiCall, type ApiError } from './client';
import type {
  CaptureErrorCode,
  EnqueueRequest,
  EnqueueResponse,
  QueueSnapshot,
  RetryRequest,
  RetryResponse,
} from './types';

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
