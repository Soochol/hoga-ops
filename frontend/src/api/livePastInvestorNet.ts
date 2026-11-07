import { useQuery, useQueryClient } from '@tanstack/react-query';

import { apiCall } from './client';
import { isDailyFlowDate, parseInvestorDailyFlow, type DailyFlowRequestScope, type InvestorDailyFlowResponse } from './investorDailyFlow';
import type { InvestorNetPoint, InvestorNetUnit, InvestorTradeSide } from './types';
import { isKrxRegularSessionNow, todayKstYyyymmdd } from '../live/liveDateTime';

export interface LivePastInvestorNetWarning {
  batch: string;
  /** Present on per-row warnings (invariant_violation); absent on batch-level
   * failures like rate_limit_upstream / api_error. */
  date?: string;
  reason: 'rate_limit_upstream' | 'api_error' | 'invariant_violation';
  msg: string;
}

/** 요청 축. 벤더 `amt_qty_tp` 의 wire 표현 — 코드값("2"=수량)이 이름과 반대라
 *  URL 에 그대로 두지 않는다. */
export type InvestorNetAxis = 'qty' | 'amount';

export interface LivePastInvestorNetResponse {
  code: string;
  from: string;
  to: string;
  /** 값의 물리량 — 축이 정한다. **표시 포맷은 저장된 토글이 아니라 이 값으로
   *  고른다**. 옛 백엔드는 이 키가 없어 옵셔널이다. */
  unit?: InvestorNetUnit;
  /** Legacy responses omitted this field and always contained net buys. */
  trade_side?: InvestorTradeSide;
  /** Strict stock quantity/net history. Other modes omit this field. */
  daily_flow?: InvestorDailyFlowResponse | null;
  points: InvestorNetPoint[];
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: LivePastInvestorNetWarning[];
}

/** A placeholder may belong to another range or unit. Strict chart consumers
 * accept only the exact canonical quantity/net response. */
export function investorDailyFlowForScope(
  response: LivePastInvestorNetResponse | undefined,
  scope: DailyFlowRequestScope,
): InvestorDailyFlowResponse | null {
  if (!response || response.code !== scope.code || response.from !== scope.from || response.to !== scope.to
    || response.unit !== 'qty_shares' || response.trade_side !== 'net' || !response.daily_flow) return null;
  try { return parseInvestorDailyFlow(response.daily_flow, scope); } catch { return null; }
}

export function useLivePastInvestorNet(
  code: string | null,
  from: string | null,
  to: string | null,
  axis: InvestorNetAxis = 'qty',
  tradeSide: InvestorTradeSide = 'net',
) {
  const queryClient = useQueryClient();
  const canonical = axis === 'qty' && tradeSide === 'net';
  const enabled = !!(code && isDailyFlowDate(from) && isDailyFlowDate(to) && from <= to);
  const queryKey = ['live', 'past-investor-net', code, from, to, axis, tradeSide] as const;
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!code || !from || !to) throw new Error('투자자 자료 조회 범위 없음');
      const scope = { code, from, to };
      let previousPages = 0;
      for (let request = 1; ; request++) {
        signal.throwIfAborted();
        const response = await apiCall<LivePastInvestorNetResponse>(
          `/api/live/past-investor-net?code=${code}&from=${from}&to=${to}&axis=${axis}&trade_side=${tradeSide}`,
          { signal },
        );
        signal.throwIfAborted();
        if ((response.trade_side ?? 'net') !== tradeSide) throw new Error('매매 기준이 다른 응답입니다');
        const flow = canonical && response.daily_flow != null
          ? investorDailyFlowForScope(response, scope) : null;
        if (canonical && response.daily_flow != null && !flow) throw new Error('투자자 자료의 응답 기준이 다릅니다');
        signal.throwIfAborted();
        queryClient.setQueryData(queryKey, response);
        if (!flow || flow.pagination !== 'incomplete' || !flow.can_continue
          || flow.pages_observed >= 128 || flow.pages_observed <= previousPages || request >= 23
          || !flow.data_warnings.some(issue => issue.reason === 'page_budget')
          || flow.data_warnings.some(issue => ['invalid_page', 'cursor_stalled', 'api_error', 'unavailable'].includes(issue.reason))) return response;
        previousPages = flow.pages_observed;
      }
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: query => query.state.fetchStatus !== 'fetching' && isKrxRegularSessionNow()
      && (!canonical || to === todayKstYyyymmdd()) ? 60_000 : false,
    ...(canonical ? { retry: false } : {}),
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
