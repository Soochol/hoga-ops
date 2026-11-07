import type { InvestorDailyFlowResponse } from '../../../src/api/investorDailyFlow';
import type { LivePastInvestorNetResponse } from '../../../src/api/livePastInvestorNet';
import type { InvestorNetPoint } from '../../../src/api/types';

export function investorNetEnvelope(input: Omit<InvestorDailyFlowResponse, 'code' | 'from' | 'to'> & { code: string | null; from: string | null; to: string | null }): LivePastInvestorNetResponse {
  const flow = { ...input, code: input.code ?? '', from: input.from ?? '', to: input.to ?? '' };
  return { code: flow.code, from: flow.from, to: flow.to, unit: 'qty_shares', trade_side: 'net', daily_flow: flow,
    points: flow.observations.map(row => ({ t_ms: row.t_ms, foreign_net: row.foreign_net_shares ?? 0,
      institution_net: row.institution_net_shares ?? 0 })), cached_batches: [], fresh_batches: [], data_warnings: [] };
}

export function netQuantityEnvelope(params: URLSearchParams, points: InvestorNetPoint[]): LivePastInvestorNetResponse {
  return investorNetEnvelope({ code: params.get('code') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '',
    source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net',
    observations: points.map(point => ({ date: new Date(point.t_ms).toISOString().slice(0, 10).replaceAll('-', ''),
      t_ms: point.t_ms, foreign_net_shares: point.foreign_net, institution_net_shares: point.institution_net })),
    pagination: 'covered', unlocated_defect: false, pages_observed: 1, can_continue: false, data_warnings: [] });
}
