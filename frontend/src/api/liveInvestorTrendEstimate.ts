import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { isKrxRegularSessionNow } from '../live/liveDateTime';

/**
 * 한 슬롯의 추정 수급 — 수량·금액 두 축이 함께 온다.
 *
 * **단위가 필드명에 박혀 있다.** 2026-08-04 이전에는 백엔드가 `amt_qty_tp="1"`
 * (금액, 백만원)만 조회해 놓고 그 값을 `_qty` 필드로 보냈고, 화면은 그것을 만주로
 * 그렸다. 두 축 모두 부호도 자릿수도 그럴듯해서 타입도 테스트도 잡지 못했다 —
 * 이름이 유일한 방어선이다. `_mwon` 을 지우지 말 것.
 *
 * 수량은 가집계라 천주 단위로 반올림돼 온다. 금액이 오히려 정밀하다.
 */
export interface LiveInvestorTrendEstimateRow {
  slot: string;
  observed_at_ms?: number;
  foreign_qty: number | null;
  institution_qty: number | null;
  sum_qty: number | null;
  foreign_amt_mwon: number | null;
  institution_amt_mwon: number | null;
  sum_amt_mwon: number | null;
}

export type InvestorEstimateWarningReason =
  | 'credentials_missing' | 'rest_bypassed' | 'rate_limit_upstream'
  | 'api_error' | 'parse_error' | 'request_pending';

export interface LiveInvestorTrendEstimateWarning {
  reason: InvestorEstimateWarningReason;
  msg: string;
}

export interface LiveInvestorTrendEstimateResponse {
  code: string;
  trading_day: string;
  fetched_at_ms: number | null;
  rows: LiveInvestorTrendEstimateRow[];
  latest: LiveInvestorTrendEstimateRow | null;
  source: 'kis';
  status: 'ok' | 'empty' | 'error';
  data_warning: LiveInvestorTrendEstimateWarning | null;
}

export function liveInvestorTrendEstimateQueryOptions(code: string | null) {
  return {
    queryKey: ['live', 'investor-trend-estimate', code] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) => {
      if (!code) {
        throw new Error('live investor trend estimate requires a code');
      }
      return fetchEstimate(code, signal);
    },
    enabled: !!code,
    staleTime: 60_000,
    refetchInterval: () => (isKrxRegularSessionNow() ? 60_000 : false),
    placeholderData: (prev: LiveInvestorTrendEstimateResponse | undefined) =>
      prev && prev.code === code ? prev : undefined,
  };
}

async function fetchEstimate(code: string, signal?: AbortSignal): Promise<LiveInvestorTrendEstimateResponse> {
  // Only the server's unfinished shared task gets fast follow-up reads.
  // Vendor errors / rate limits / missing credentials keep the normal cadence.
  // One query owns at most three HTTP attempts, also outside market hours.
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await apiCall<LiveInvestorTrendEstimateResponse>(
      `/api/live/investor-trend-estimate?code=${code}`, { signal },
    );
    if (response.status !== 'error' || response.data_warning?.reason !== 'request_pending' || attempt >= 2) {
      return response;
    }
    await waitForEstimate(1_000 * (attempt + 1), signal);
  }
}

function waitForEstimate(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function useLiveInvestorTrendEstimate(code: string | null) {
  return useQuery(liveInvestorTrendEstimateQueryOptions(code));
}
