import { useCallback, useEffect, useRef, useState } from 'react';
import { useCaptureQueue } from '../capture/useCaptureQueue';
import type { ApiError } from '../api/client';
import type { EnqueueResponse, UpstreamCode } from '../api/types';
import { enqueueErrorHints } from '../api/upstream-hints';
import { useInventoryRecaptureOrigins } from './useInventoryRecaptureOrigins';
import type { ReactNode } from 'react';

export type RecaptureStatus =
  | { kind: 'success'; enqueued: number; skipped: number }
  | { kind: 'error'; message: ReactNode };

const SUCCESS_AUTOCLEAR_MS = 4_000;

/**
 * **Single-consumer contract.** `status` is React component-local state; if
 * two components mount this hook concurrently, only the instance that
 * originated a `recapture()` call sees the resulting success/error. Today
 * only `StockDateGroupDetail` mounts it, and the surface (Re-capture all +
 * per-row ↻) lives in that one component, so a single instance is enough.
 *
 * If a future caller needs the status outside `StockDateGroupDetail`, hoist
 * `status` (and the success-autoclear timer) into a zustand store — do not
 * mount this hook twice and expect both views to stay in sync.
 */
export function useInventoryRecapture() {
  const { addItems } = useCaptureQueue();
  const [status, setStatus] = useState<RecaptureStatus | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSuccessTimer = useCallback(() => {
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSuccessTimer, [clearSuccessTimer]);

  const recapture = useCallback(
    async (code: string, dates: string[], forceRetry = false): Promise<void> => {
      if (dates.length === 0) return;
      clearSuccessTimer();
      try {
        const resp: EnqueueResponse = await addItems.mutateAsync({
          code,
          dates,
          // ADR-0093: forceRetry bypasses the confirmed-upstream-gap skip so the
          // user can re-verify. Defaults false — the normal ↻ / Re-capture all.
          force_retry: forceRetry,
        });
        useInventoryRecaptureOrigins.getState().add(resp.enqueued.map((i) => i.item_id));
        setStatus({
          kind: 'success',
          enqueued: resp.enqueued.length,
          skipped: resp.deduped.length,
        });
        successTimerRef.current = setTimeout(() => {
          setStatus(null);
          successTimerRef.current = null;
        }, SUCCESS_AUTOCLEAR_MS);
      } catch (err) {
        const apiErr = err as ApiError;
        const errCode = apiErr.code;
        const message: ReactNode =
          errCode && errCode in enqueueErrorHints
            ? enqueueErrorHints[errCode as UpstreamCode]
            : err instanceof Error
              ? err.message
              : 'Failed to enqueue re-capture';
        setStatus({ kind: 'error', message });
      }
    },
    [addItems, clearSuccessTimer],
  );

  return { recapture, status, isPending: addItems.isPending };
}
