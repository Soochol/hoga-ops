import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiCall } from '../api/client';
import { STOCK_DATES_QUERY_KEY } from '../api/stock-dates';

/**
 * ADR-0042: zero the fail_streak counter for one (Code, Stock-Date).
 *
 * Backend endpoint: POST /api/captures/items/{code}/{date}/unblock
 * Idempotent — backend returns ``action: 'noop'`` when already zero;
 * we treat noop and unblocked identically (invalidate the inventory query
 * either way so a stale 차단됨 badge can't linger).
 *
 * The hook is a single-mutation client; mounting it twice in the same tree
 * is harmless but only the calling component sees pending/error state.
 */

export interface UnblockArgs {
  code: string;
  date: string;
}

export interface UnblockResponse {
  code: string;
  date: string;
  fail_streak: 0;
  action: 'unblocked' | 'noop';
}

async function postUnblock({ code, date }: UnblockArgs): Promise<UnblockResponse> {
  return apiCall<UnblockResponse>(
    `/api/captures/items/${code}/${date}/unblock`,
    { method: 'POST' },
  );
}

export function useInventoryUnblock() {
  const qc = useQueryClient();
  const unblock = useMutation({
    mutationFn: postUnblock,
    onSuccess: () => {
      // Refresh inventory so the row drops its 차단됨 badge.
      qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
    },
  });
  return { unblock };
}
