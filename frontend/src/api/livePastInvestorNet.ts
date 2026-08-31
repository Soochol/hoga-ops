import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { InvestorNetPoint, InvestorNetUnit } from './types';
import { isKrxRegularSessionNow } from '../live/liveDateTime';

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
   *  고른다**(아래 훅 도크스트링). 옛 백엔드는 이 키가 없어 옵셔널이다. */
  unit?: InvestorNetUnit;
  points: InvestorNetPoint[];
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: LivePastInvestorNetWarning[];
}

/** GET /api/live/past-investor-net — daily investor net-buy across [from, to].
 * `ka10059` walks back by date cursor, so this mirrors useLivePastDailyCandles
 * with a batch/gap cache (ADR-0055). 차트 pane 은 축을 안 넘겨 수량으로 돈다.
 *
 * ⚠ **소비자는 `data.unit` 으로 포맷터를 고를 것 — 저장된 토글로 고르면 안 된다.**
 * 축이 쿼리 키에 들어 있고 `placeholderData` 가 이전 데이터를 넘겨주므로, 축을
 * 바꾼 직후 한 프레임 동안 **옛 축의 값이 새 데이터인 척** 손에 들어온다. 그때
 * 토글을 따라 포맷하면 1,589,169주가 "15,892억" 으로 그려진다(#1119 부류, 100배).
 * 응답이 자기 단위를 말하므로 그 값을 따르면 낡은 데이터도 제 단위로 그려진다.
 *
 * placeholder 를 끄는 것은 답이 아니다 — 축을 오갈 때마다 표가 통째로 사라진다. */
export function useLivePastInvestorNet(
  code: string | null,
  from: string | null,
  to: string | null,
  axis: InvestorNetAxis = 'qty',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-investor-net', code, from, to, axis] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastInvestorNetResponse>(
        `/api/live/past-investor-net?code=${code}&from=${from}&to=${to}&axis=${axis}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: () => (isKrxRegularSessionNow() ? 60_000 : false),
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
